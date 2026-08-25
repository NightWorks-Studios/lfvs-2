import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import postgres from 'postgres'

const tables = ['authors', 'resources', 'resource_authors', 'resource_histories', 'checkpoints']
const batchSize = 1000

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}

function quote(name) {
  return `"${name.replaceAll('"', '""')}"`
}

function fail(message) {
  console.error(`Migration failed: ${message}`)
  process.exitCode = 1
}

if (!process.argv.includes('--truncate')) {
  fail('pass --truncate to replace the PostgreSQL LFVS tables')
} else if (!process.env.PGPASSWORD) {
  fail('set PGPASSWORD before running the migration')
} else {
  const sourcePath = option('source', './data/cordis.db')
  const sql = postgres({
    host: option('host', '127.0.0.1'),
    port: Number(option('port', '5432')),
    username: option('user', 'postgres'),
    password: process.env.PGPASSWORD,
    database: option('database', 'lfvs2'),
  })
  const source = new DatabaseSync(sourcePath, { readOnly: true })

  try {
    const targetColumns = await sql`
      select table_name, column_name, data_type, udt_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = any(${tables})
      order by ordinal_position
    `
    const targetByTable = new Map(tables.map((table) => [table, new Map()]))
    for (const column of targetColumns) targetByTable.get(column.table_name)?.set(column.column_name, column)

    const sources = new Map()
    for (const table of tables) {
      const columns = source.prepare(`pragma table_info(${quote(table)})`).all().map((row) => row.name)
      if (!columns.length) throw new Error(`source table is missing: ${table}`)
      const missing = columns.filter((column) => !targetByTable.get(table)?.has(column))
      if (missing.length) throw new Error(`target table ${table} is missing columns: ${missing.join(', ')}`)
      const rows = source.prepare(`select ${columns.map(quote).join(', ')} from ${quote(table)} order by "pk"`).all()
      sources.set(table, { columns, rows })
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(`TRUNCATE TABLE ${tables.map(quote).join(', ')} RESTART IDENTITY CASCADE`)
      for (const table of tables) {
        const { columns, rows } = sources.get(table)
        const definitions = targetByTable.get(table)
        for (let offset = 0; offset < rows.length; offset += batchSize) {
          const values = rows.slice(offset, offset + batchSize).map((row) => columns.map((column) => {
            const value = row[column]
            if (value === null || value === undefined) return value
            const definition = definitions.get(column)
            if (definition.data_type.includes('timestamp')) return new Date(Number(value))
            if (definition.data_type === 'boolean') return !!value
            if (definition.udt_name === 'json' || definition.udt_name === 'jsonb') return typeof value === 'string' ? JSON.parse(value) : value
            return value
          }))
          const parameters = values.flat()
          const placeholders = values.map((row, rowIndex) => {
            const offset = rowIndex * columns.length
            return `(${row.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`
          })
          const statement = `insert into ${quote(table)} (${columns.map(quote).join(', ')}) values ${placeholders.join(', ')}`
          await tx.unsafe(statement, parameters)
        }
        await tx.unsafe(`
          select setval(
            pg_get_serial_sequence('${table}', 'pk'),
            coalesce((select max("pk") from ${quote(table)}), 1),
            (select count(*) > 0 from ${quote(table)})
          )
        `)
        console.log(`${table}: ${rows.length}`)
      }
    })
    console.log('Migration completed successfully.')
  } catch (error) {
    fail(error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    source.close()
    await sql.end({ timeout: 5 })
  }
}

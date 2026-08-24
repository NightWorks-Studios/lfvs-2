<template>
  <k-card class="vocaloard-card">
    <div class="heading">
      <div>
        <h2>Vocaloard YouTube 导入</h2>
        <p>从 Vocaloard 排行榜补全本地尚不存在的 YouTube 视频，不会重复写入已有资源。</p>
      </div>
      <el-tag :type="status.progress.running ? 'warning' : 'success'">
        {{ status.progress.running ? '导入中' : '空闲' }}
      </el-tag>
    </div>

    <div class="latest-grid">
      <div v-for="mode in modes" :key="mode" class="latest-item">
        <span>{{ modeLabel(mode) }}</span>
        <strong>{{ status.latest[mode]?.date || '尚未检查' }}</strong>
        <small v-if="status.latest[mode]">最近导入 {{ status.latest[mode]?.imported ?? 0 }} 项</small>
        <small v-else>等待首次检查</small>
      </div>
    </div>

    <el-form label-position="top" class="import-form">
      <el-form-item label="榜单模式">
        <el-radio-group v-model="form.mode" :disabled="status.progress.running || busy">
          <el-radio-button label="daily">普通日榜</el-radio-button>
          <el-radio-button label="new-original">新着原创曲日榜</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <div class="date-fields">
        <el-form-item label="开始日期"><el-date-picker v-model="form.from" type="date" value-format="YYYY-MM-DD" :clearable="false" /></el-form-item>
        <el-form-item label="结束日期"><el-date-picker v-model="form.to" type="date" value-format="YYYY-MM-DD" :clearable="false" /></el-form-item>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="busy" :disabled="status.progress.running" @click="importRange">导入日期范围</el-button>
        <el-button :loading="checking" :disabled="status.progress.running || busy" @click="checkLatest">检查并导入最新榜单</el-button>
      </div>
    </el-form>

    <template v-if="status.progress.running || status.progress.lastError">
      <div class="progress-heading">
        <strong>{{ taskLabel }}</strong>
        <span v-if="status.progress.date">{{ status.progress.date }}</span>
      </div>
      <el-progress v-if="status.progress.running" :percentage="progressPercent" />
      <div class="progress-stats">
        <span>日期 {{ status.progress.datesCompleted }}/{{ status.progress.datesTotal || '-' }}</span>
        <span>页面 {{ status.progress.page }}/{{ status.progress.totalPages || '-' }}</span>
        <span>发现 {{ status.progress.discovered }}</span>
        <span>待导入 {{ status.progress.missing }}</span>
        <span>已导入 {{ status.progress.imported }}</span>
        <span>跳过日期 {{ status.progress.skippedDates }}</span>
      </div>
      <p v-if="status.progress.lastError" class="message">{{ status.progress.lastError }}</p>
    </template>

    <p v-if="message" class="message" :class="{ success: messageType === 'success' }">{{ message }}</p>
  </k-card>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRpc } from '@cordisjs/client'

type SourceMode = 'daily' | 'new-original'

interface LatestRecord {
  date: string
  pages: number
  importedAt: number
  imported: number
}

interface Progress {
  running: boolean
  task: 'auto' | 'range' | ''
  mode: SourceMode | ''
  date: string
  from: string
  to: string
  page: number
  totalPages: number
  datesCompleted: number
  datesTotal: number
  pagesFetched: number
  discovered: number
  missing: number
  imported: number
  skippedDates: number
  lastError: string
}

interface Status {
  modes: SourceMode[]
  latest: Partial<Record<SourceMode, LatestRecord>>
  progress: Progress
}

interface Rpc {
  status(): Promise<Status>
  importRange(input: { mode: SourceMode; from: string; to: string }): Promise<void>
  checkLatest(): Promise<void>
}

const today = new Date().toISOString().slice(0, 10)
const rpc = useRpc<Rpc>()
const status = reactive<Status>({
  modes: ['daily', 'new-original'],
  latest: {},
  progress: {
    running: false, task: '', mode: '', date: '', from: '', to: '', page: 0, totalPages: 0,
    datesCompleted: 0, datesTotal: 0, pagesFetched: 0, discovered: 0, missing: 0, imported: 0,
    skippedDates: 0, lastError: '',
  },
})
const form = reactive<{ mode: SourceMode; from: string; to: string }>({ mode: 'daily', from: today, to: today })
const busy = ref(false)
const checking = ref(false)
const message = ref('')
const messageType = ref<'error' | 'success'>('error')
let timer: ReturnType<typeof setInterval> | undefined

const modes = computed(() => status.modes.length ? status.modes : ['daily', 'new-original'])
const taskLabel = computed(() => status.progress.task === 'auto' ? '检查最新榜单' : '导入日期范围')
const progressPercent = computed(() => {
  if (status.progress.task === 'range' && status.progress.datesTotal) {
    const pageFraction = status.progress.totalPages ? status.progress.page / status.progress.totalPages : 0
    return Math.min(100, Math.round((status.progress.datesCompleted + pageFraction) / status.progress.datesTotal * 100))
  }
  if (!status.progress.totalPages) return 0
  return Math.min(100, Math.round(status.progress.page / status.progress.totalPages * 100))
})

function modeLabel(mode: SourceMode) {
  return mode === 'daily' ? '普通日榜' : '新着原创曲日榜'
}

async function refresh() {
  Object.assign(status, await rpc.value.status())
}

async function importRange() {
  busy.value = true
  message.value = ''
  try {
    await rpc.value.importRange({ ...form })
    messageType.value = 'success'
    message.value = '导入完成'
  } catch (error: any) {
    messageType.value = 'error'
    message.value = error?.message ?? String(error)
  } finally {
    busy.value = false
    await refresh()
  }
}

async function checkLatest() {
  checking.value = true
  message.value = ''
  try {
    await rpc.value.checkLatest()
    messageType.value = 'success'
    message.value = '最新榜单检查完成'
  } catch (error: any) {
    messageType.value = 'error'
    message.value = error?.message ?? String(error)
  } finally {
    checking.value = false
    await refresh()
  }
}

onMounted(async () => {
  await refresh()
  timer = setInterval(() => void refresh(), 2000)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.vocaloard-card { margin: 24px; padding: 24px; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
h2 { margin: 0 0 6px; font-size: 22px; }
p { margin: 0; color: var(--fg3); }
.latest-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
.latest-item { padding: 14px; border: 1px solid var(--k-color-divider); border-radius: 6px; }
.latest-item span, .latest-item small { display: block; color: var(--fg3); font-size: 12px; }
.latest-item strong { display: block; margin: 5px 0; font-size: 19px; }
.import-form { max-width: 620px; }
.date-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.date-fields :deep(.el-date-editor) { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.progress-heading { display: flex; justify-content: space-between; gap: 12px; margin: 22px 0 10px; }
.progress-heading span { color: var(--fg3); }
.progress-stats { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; color: var(--fg3); font-size: 13px; }
.message { margin-top: 16px; color: var(--k-color-danger); }
.message.success { color: var(--k-color-success); }
@media (max-width: 720px) { .vocaloard-card { margin: 12px; padding: 16px; } .heading { flex-direction: column; } .latest-grid, .date-fields { grid-template-columns: 1fr; } }
</style>

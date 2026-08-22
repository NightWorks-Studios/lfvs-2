<template>
  <el-table :data="items" row-key="id" v-loading="loading" @row-click="open">
    <el-table-column label="资源" min-width="320">
      <template #default="{ row }">
        <div class="resource-cell">
          <img v-if="row.coverUrl" :src="row.coverUrl" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div v-else class="cover-empty" />
          <div class="resource-copy">
            <a class="lfvs-link title" @click.stop="open(row)">{{ row.title }}</a>
            <span>{{ row.id }}</span>
          </div>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="平台 / 类型" width="140">
      <template #default="{ row }"><span class="lfvs-platform">{{ row.platform }} / {{ row.kind }}</span></template>
    </el-table-column>
    <el-table-column label="创作者" min-width="180">
      <template #default="{ row }">
        <div class="authors">
          <a
            v-for="author in row.authors.slice(0, 3)"
            :key="`${author.platform}:${author.id}`"
            class="lfvs-link"
            @click.stop="openCreator(author)"
          >{{ author.name || author.id }}</a>
          <span v-if="!row.authors.length" class="lfvs-subtle">-</span>
          <span v-if="row.authors.length > 3" class="lfvs-subtle">+{{ row.authors.length - 3 }}</span>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="发布时间" width="170">
      <template #default="{ row }">{{ formatTime(row.publishTime) }}</template>
    </el-table-column>
    <el-table-column label="最后同步" width="170">
      <template #default="{ row }">{{ formatTime(row.lastSyncedAt) }}</template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { useRouter } from '@cordisjs/client'
import type { ResourceRow } from '../src'
import { formatTime, openAuthor, openResource } from './common'

defineProps<{ items: ResourceRow[]; loading?: boolean }>()
const router = useRouter()
const open = (row: ResourceRow) => void openResource(router, row)
const openCreator = (author: ResourceRow['authors'][number]) => void openAuthor(router, author)
</script>

<style scoped>
.resource-cell { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 54px; }
.resource-cell img, .cover-empty { width: 86px; aspect-ratio: 16 / 10; border-radius: 4px; object-fit: cover; background: #e8ebef; }
.resource-copy { min-width: 0; }
.resource-copy .title { display: block; overflow: hidden; color: var(--fg1); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.resource-copy span { display: block; margin-top: 4px; color: var(--fg3); font-family: var(--font-mono); font-size: 11px; }
.authors { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
:deep(.el-table__row) { cursor: pointer; }
</style>

<template>
  <el-table :data="items" row-key="id" v-loading="loading" @row-click="open">
    <el-table-column label="创作者" min-width="280">
      <template #default="{ row }">
        <div class="author-cell">
          <img v-if="row.avatarUrl" :src="row.avatarUrl" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div v-else class="avatar-empty" />
          <div>
            <a class="lfvs-link name" @click.stop="open(row)">{{ row.name || row.id }}</a>
            <span>{{ row.id }}</span>
          </div>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="平台" width="120">
      <template #default="{ row }"><span class="lfvs-platform">{{ row.platform }}</span></template>
    </el-table-column>
    <el-table-column prop="resourceCount" label="资源数" width="110" />
    <el-table-column label="状态" width="110">
      <template #default="{ row }">
        <el-tag v-if="row.isPlaceholder" type="warning" size="small">占位</el-tag>
        <el-tag v-else type="success" size="small">已同步</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="最后同步" width="170">
      <template #default="{ row }">{{ formatTime(row.lastSyncedAt) }}</template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { useRouter } from '@cordisjs/client'
import type { AuthorRow } from '../src'
import { formatTime, openAuthor } from './common'

defineProps<{ items: AuthorRow[]; loading?: boolean }>()
const router = useRouter()
const open = (row: AuthorRow) => void openAuthor(router, row)
</script>

<style scoped>
.author-cell { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 11px; align-items: center; min-height: 50px; }
.author-cell img, .avatar-empty { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #e8ebef; }
.author-cell .name { display: block; overflow: hidden; color: var(--fg1); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.author-cell span { display: block; margin-top: 3px; color: var(--fg3); font-family: var(--font-mono); font-size: 11px; }
:deep(.el-table__row) { cursor: pointer; }
</style>

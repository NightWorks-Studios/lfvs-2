<template>
  <k-layout>
    <template #header><span>LFVS 总览</span></template>
    <template #menu>
      <el-button text circle title="刷新" :loading="loading" @click="load"><RefreshCw :size="16" /></el-button>
    </template>
    <div class="lfvs-page">
      <main class="lfvs-content">
        <div class="metrics" v-loading="loading">
          <button class="metric metric-authors" type="button" @click="router.push('/lfvs/authors')">
            <span>创作者</span><strong>{{ formatNumber(data?.authors ?? 0) }}</strong><Users :size="19" />
          </button>
          <button class="metric metric-resources" type="button" @click="router.push('/lfvs/resources')">
            <span>资源</span><strong>{{ formatNumber(data?.resources ?? 0) }}</strong><Video :size="19" />
          </button>
          <div class="metric metric-history">
            <span>快照</span><strong>{{ formatNumber(data?.histories ?? 0) }}</strong><LineChart :size="19" />
          </div>
        </div>

        <div v-if="error" class="lfvs-error">{{ error }}</div>

        <section class="status-band">
          <div><span>在线适配器</span><strong>{{ data?.adapters ?? 0 }}</strong></div>
          <div><span>在线更新器</span><strong>{{ data?.updaters ?? 0 }}</strong></div>
          <div><span>最近资源同步</span><strong>{{ formatTime(data?.lastResourceSyncAt) }}</strong></div>
          <div><span>最近快照</span><strong>{{ formatTime(data?.lastHistoryAt) }}</strong></div>
          <el-button text @click="router.push('/lfvs/runtime')">查看运行状态 <ArrowRight :size="15" /></el-button>
        </section>

        <section class="lfvs-section">
          <h2 class="lfvs-section-title">
            <span>数据分布</span>
            <span class="lfvs-subtle">按平台与资源类型统计</span>
          </h2>
          <el-table :data="data?.breakdown ?? []" v-loading="loading">
            <el-table-column prop="platform" label="平台" min-width="150">
              <template #default="{ row }"><span class="lfvs-platform">{{ row.platform }}</span></template>
            </el-table-column>
            <el-table-column prop="kind" label="资源类型" min-width="150" />
            <el-table-column label="资源" min-width="140" align="right">
              <template #default="{ row }">{{ formatNumber(row.resources) }}</template>
            </el-table-column>
            <el-table-column label="快照" min-width="140" align="right">
              <template #default="{ row }">{{ formatNumber(row.histories) }}</template>
            </el-table-column>
            <el-table-column width="80" align="right">
              <template #default="{ row }">
                <el-button text circle title="查看资源" @click="openGroup(row)"><ArrowRight :size="15" /></el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </main>
    </div>
  </k-layout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, useRpc } from '@cordisjs/client'
import { ArrowRight, LineChart, RefreshCw, Users, Video } from '@lucide/vue'
import type { Data, Overview } from '../src'
import { errorText, formatNumber, formatTime } from './common'

const rpc = useRpc<Data>()
const router = useRouter()
const data = ref<Overview>()
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try { data.value = await rpc.value.overview() }
  catch (cause) { error.value = errorText(cause) }
  finally { loading.value = false }
}

function openGroup(row: Overview['breakdown'][number]) {
  void router.push({ path: '/lfvs/resources', query: { platform: row.platform, kind: row.kind } })
}

onMounted(load)
</script>

<style scoped>
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; min-height: 126px; }
.metric { position: relative; display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto 1fr; gap: 8px; min-width: 0; min-height: 126px; padding: 18px 20px; border: 1px solid var(--k-color-divider); border-top-width: 3px; border-radius: 6px; background: var(--bg1, #fff); color: var(--fg1); text-align: left; }
button.metric { cursor: pointer; font: inherit; }
button.metric:hover { border-color: #9aa3af; }
.metric span { color: var(--fg3); font-size: 12px; }
.metric strong { align-self: end; overflow: hidden; font-size: 30px; font-weight: 680; letter-spacing: 0; text-overflow: ellipsis; }
.metric svg { grid-column: 2; grid-row: 1; }
.metric-authors { border-top-color: #368a70; }
.metric-authors svg { color: #368a70; }
.metric-resources { border-top-color: #3479a8; }
.metric-resources svg { color: #3479a8; }
.metric-history { border-top-color: #b17c29; }
.metric-history svg { color: #b17c29; }
.status-band { display: grid; grid-template-columns: 120px 120px minmax(190px, 1fr) minmax(190px, 1fr) auto; gap: 0; align-items: center; margin-top: 18px; border-block: 1px solid var(--k-color-divider); background: var(--bg1, #fff); }
.status-band > div { min-width: 0; padding: 13px 16px; border-right: 1px solid var(--k-color-divider); }
.status-band span { display: block; color: var(--fg3); font-size: 11px; }
.status-band strong { display: block; margin-top: 3px; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.status-band .el-button { margin: 0 10px; }
.status-band :deep(.el-button > span) { display: inline-flex; align-items: center; gap: 5px; color: inherit; font-size: inherit; }
@media (max-width: 900px) { .status-band { grid-template-columns: repeat(2, 1fr); } .status-band .el-button { min-height: 46px; } }
@media (max-width: 620px) { .metrics { grid-template-columns: 1fr; } }
</style>

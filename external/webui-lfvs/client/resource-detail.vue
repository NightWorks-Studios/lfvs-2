<template>
  <k-layout>
    <template #header><span>资源详情</span></template>
    <template #menu>
      <el-button text circle title="返回资源列表" @click="router.push('/lfvs/resources')"><ArrowLeft :size="16" /></el-button>
      <el-button text circle title="刷新" :loading="loading" @click="load"><RefreshCw :size="16" /></el-button>
    </template>
    <div class="lfvs-page">
      <main class="lfvs-content" v-loading="loading">
        <div v-if="error" class="lfvs-error">{{ error }}</div>
        <template v-if="resource">
          <section class="lfvs-detail-head">
            <img v-if="resource.coverUrl" class="lfvs-detail-cover" :src="resource.coverUrl" alt="" referrerpolicy="no-referrer" />
            <div v-else class="lfvs-detail-cover" />
            <div>
              <h1 class="lfvs-detail-title">{{ resource.title }}</h1>
              <div class="lfvs-meta-line">
                <span class="lfvs-platform">{{ resource.platform }} / {{ resource.kind }}</span>
                <span>{{ resource.id }}</span>
                <span>发布 {{ formatTime(resource.publishTime) }}</span>
                <span>时长 {{ formatDuration(resource.duration) }}</span>
                <span>同步 {{ formatTime(resource.lastSyncedAt) }}</span>
              </div>
              <p v-if="resource.description" class="lfvs-description">{{ resource.description }}</p>
            </div>
          </section>

          <section class="lfvs-section">
            <h2 class="lfvs-section-title">创作者</h2>
            <div class="lfvs-author-list">
              <button v-for="author in resource.authors" :key="author.id" class="lfvs-author-chip" type="button" @click="openAuthor(router, author)">
                <img v-if="author.avatarUrl" :src="author.avatarUrl" alt="" referrerpolicy="no-referrer" />
                <span v-else class="lfvs-avatar" />
                <span>{{ author.name || author.id }}<small v-if="author.role">{{ author.role }}</small></span>
              </button>
              <span v-if="!resource.authors.length" class="lfvs-subtle">暂无关联创作者</span>
            </div>
          </section>

          <section v-if="Object.keys(resource.extension).length" class="lfvs-section">
            <h2 class="lfvs-section-title">扩展信息</h2>
            <dl class="lfvs-key-values">
              <div v-for="(value, key) in resource.extension" :key="key"><dt>{{ key }}</dt><dd>{{ displayValue(value) }}</dd></div>
            </dl>
          </section>

          <section class="lfvs-section">
            <div class="history-heading">
              <h2 class="lfvs-section-title">历史趋势</h2>
              <el-radio-group v-model="range" size="small" @change="loadHistory">
                <el-radio-button value="24h">24 小时</el-radio-button>
                <el-radio-button value="7d">7 天</el-radio-button>
                <el-radio-button value="30d">30 天</el-radio-button>
                <el-radio-button value="all">全部</el-radio-button>
              </el-radio-group>
            </div>
            <el-checkbox-group v-model="selected" class="metric-selector">
              <el-checkbox-button v-for="field in numericFields" :key="field.name" :value="field.name">{{ field.label }}</el-checkbox-button>
            </el-checkbox-group>
            <el-alert v-if="history?.truncated" title="快照超过 5000 条，当前图表显示最近 5000 条。" type="warning" :closable="false" show-icon />
            <history-chart v-if="history?.points.length" :points="history.points" :fields="history.fields" :selected="selected" />
            <div v-else class="lfvs-empty">暂无历史快照</div>
          </section>

          <section v-if="history?.points.length" class="lfvs-section">
            <h2 class="lfvs-section-title"><span>快照明细</span><span class="lfvs-subtle">最近 50 条</span></h2>
            <el-table :data="history.points.slice(-50).reverse()">
              <el-table-column label="采集时间" width="180"><template #default="{ row }">{{ formatTime(row.capturedAt) }}</template></el-table-column>
              <el-table-column v-for="field in history.fields" :key="field.name" :label="field.label" min-width="120" align="right">
                <template #default="{ row }">{{ formatMetric(row.values[field.name]) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </template>
        <div v-else-if="!loading && !error" class="lfvs-empty">资源不存在</div>
      </main>
    </div>
  </k-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, useRpc } from '@cordisjs/client'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import type { Data, HistoryResult, ResourceDetail } from '../src'
import { errorText, formatDuration, formatMetric, formatTime, openAuthor } from './common'
import HistoryChart from './history-chart.vue'

const rpc = useRpc<Data>()
const route = useRoute()
const router = useRouter()
const resource = ref<ResourceDetail | null>()
const history = ref<HistoryResult>()
const range = ref<'24h' | '7d' | '30d' | 'all'>('30d')
const selected = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const numericTypes = new Set(['integer', 'unsigned', 'float', 'double', 'decimal', 'bigint'])
const numericFields = computed(() => history.value?.fields.filter((field) => numericTypes.has(field.type)) ?? [])

function key() {
  return {
    platform: decodeURIComponent(route.params.platform),
    kind: decodeURIComponent(route.params.kind),
    id: decodeURIComponent(route.params.id),
  }
}

async function loadHistory() {
  history.value = await rpc.value.getResourceHistory({ ...key(), range: range.value })
  const available = new Set(numericFields.value.map((field) => field.name))
  selected.value = selected.value.filter((name) => available.has(name))
  if (!selected.value.length) selected.value = numericFields.value.slice(0, 2).map((field) => field.name)
}

async function load() {
  loading.value = true
  error.value = ''
  try { resource.value = await rpc.value.getResource(key()); await loadHistory() }
  catch (cause) { error.value = errorText(cause) }
  finally { loading.value = false }
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return '-'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

watch(() => route.fullPath, load)
onMounted(load)
</script>

<style scoped>
.lfvs-author-chip { font: inherit; text-align: left; }
.lfvs-author-chip span:last-child { color: var(--fg1); font-size: 12px; }
.lfvs-author-chip small { display: block; margin-top: 2px; color: var(--fg3); font-size: 10px; }
.history-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.history-heading .lfvs-section-title { margin: 0; }
.metric-selector { display: flex; flex-wrap: wrap; margin-bottom: 14px; }
.el-alert { margin-bottom: 12px; }
@media (max-width: 620px) { .history-heading { align-items: flex-start; flex-direction: column; } }
</style>

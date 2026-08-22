<template>
  <k-layout>
    <template #header><span>LFVS 运行状态</span></template>
    <template #menu>
      <el-button text circle title="刷新" :loading="loading" @click="load"><RefreshCw :size="16" /></el-button>
    </template>
    <div class="lfvs-page">
      <main class="lfvs-content">
        <div v-if="error" class="lfvs-error">{{ error }}</div>
        <el-tabs v-model="tab" class="runtime-tabs">
          <el-tab-pane :label="`适配器 ${data?.adapters.length ?? 0}`" name="adapters">
            <el-table :data="data?.adapters ?? []" v-loading="loading">
              <el-table-column label="目标" min-width="180">
                <template #default="{ row }"><span class="lfvs-platform">{{ row.platform }} / {{ row.kind }}</span></template>
              </el-table-column>
              <el-table-column label="批量资源" min-width="170">
                <template #default="{ row }"><Capability :value="row.capabilities.resourceBatch" /></template>
              </el-table-column>
              <el-table-column label="批量创作者" min-width="170">
                <template #default="{ row }"><Capability :value="row.capabilities.authorBatch" /></template>
              </el-table-column>
              <el-table-column label="创作者资源列表" min-width="150">
                <template #default="{ row }"><StateTag :enabled="!!row.capabilities.listAuthorResources" /></template>
              </el-table-column>
              <el-table-column label="上线时间" width="170"><template #default="{ row }">{{ formatTime(row.registeredAt) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane :label="`更新器 ${data?.updaters.length ?? 0}`" name="updaters">
            <el-table :data="data?.updaters ?? []" v-loading="loading">
              <el-table-column label="更新器" min-width="210">
                <template #default="{ row }"><strong>{{ row.label }}</strong><small>{{ row.id }}</small></template>
              </el-table-column>
              <el-table-column label="目标" width="160"><template #default="{ row }"><span class="lfvs-platform">{{ row.platform }} / {{ row.kind }}</span></template></el-table-column>
              <el-table-column prop="cron" label="CRON" width="130" />
              <el-table-column label="状态" width="110">
                <template #default="{ row }"><el-tag :type="row.running ? 'warning' : row.lastError ? 'danger' : 'success'" size="small">{{ row.running ? '运行中' : row.lastError ? '失败' : '就绪' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="最近完成" width="170"><template #default="{ row }">{{ formatTime(row.lastFinishedAt) }}</template></el-table-column>
              <el-table-column label="最近结果" min-width="180"><template #default="{ row }"><span :title="row.lastError">{{ resultText(row) }}</span></template></el-table-column>
              <el-table-column width="92" align="right">
                <template #default="{ row }">
                  <el-button type="primary" text :disabled="!row.manualTrigger || row.running" :loading="triggering === row.id" @click="trigger(row.id)"><Play :size="15" /> 运行</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane :label="`扩展字段 ${data?.fields.length ?? 0}`" name="fields">
            <el-table :data="data?.fields ?? []" v-loading="loading">
              <el-table-column prop="owner" label="更新器" min-width="190" />
              <el-table-column label="目标" width="160"><template #default="{ row }"><span class="lfvs-platform">{{ row.platform }} / {{ row.kind }}</span></template></el-table-column>
              <el-table-column prop="table" label="数据域" width="150" />
              <el-table-column prop="name" label="字段" min-width="190" />
              <el-table-column prop="type" label="类型" width="120" />
              <el-table-column label="可空" width="90"><template #default="{ row }"><StateTag :enabled="row.nullable" /></template></el-table-column>
              <el-table-column label="索引" width="90"><template #default="{ row }"><StateTag :enabled="row.indexed" /></template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </main>
    </div>
  </k-layout>
</template>

<script setup lang="ts">
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRpc } from '@cordisjs/client'
import { Play, RefreshCw } from '@lucide/vue'
import type { Data, RuntimeInfo } from '../src'
import { errorText, formatTime } from './common'

const rpc = useRpc<Data>()
const data = ref<RuntimeInfo>()
const tab = ref('adapters')
const loading = ref(false)
const triggering = ref('')
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const StateTag = defineComponent({
  props: { enabled: Boolean },
  setup: (props) => () => h('span', { class: ['state-dot', props.enabled ? 'yes' : 'no'] }, props.enabled ? '支持' : '不支持'),
})
const Capability = defineComponent({
  props: { value: Object as () => { supported: boolean; maxBatchSize?: number; recommendedBatchSize?: number } | undefined },
  setup: (props) => () => h('span', { class: ['state-dot', props.value?.supported ? 'yes' : 'no'] }, props.value?.supported ? `支持 · 最大 ${props.value.maxBatchSize ?? '-'}` : '不支持'),
})

async function load(silent = false) {
  if (!silent) loading.value = true
  error.value = ''
  try { data.value = await rpc.value.runtime() }
  catch (cause) { error.value = errorText(cause) }
  finally { loading.value = false }
}

async function trigger(id: string) {
  triggering.value = id
  error.value = ''
  try { await rpc.value.triggerUpdater(id); await load(true) }
  catch (cause) { error.value = errorText(cause) }
  finally { triggering.value = '' }
}

function resultText(row: RuntimeInfo['updaters'][number]) {
  if (row.lastError) return row.lastError
  if (!row.lastResult) return '-'
  return Object.entries(row.lastResult).map(([key, value]) => `${key}: ${value}`).join(' · ')
}

onMounted(() => { void load(); timer = setInterval(() => void load(true), 3000) })
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.runtime-tabs { min-height: 460px; }
strong { display: block; color: var(--fg1); font-size: 13px; }
small { display: block; margin-top: 3px; color: var(--fg3); font-family: var(--font-mono); font-size: 10px; }
.state-dot { display: inline-flex; align-items: center; gap: 6px; color: var(--fg3); font-size: 12px; }
.state-dot::before { width: 7px; height: 7px; border-radius: 50%; background: #9aa3af; content: ''; }
.state-dot.yes::before { background: #368a70; }
.state-dot.no::before { background: #aab0b8; }
:deep(.el-button > span) { display: inline-flex; align-items: center; gap: 5px; }
</style>

<template>
  <k-layout>
    <template #header><span>LFVS 资源</span><span class="header-count">{{ result.total }} 条</span></template>
    <div class="lfvs-page">
      <main class="lfvs-content">
        <form class="lfvs-toolbar" @submit.prevent="search(1)">
          <el-input v-model="filters.name" clearable placeholder="资源名称 / 标题"><template #prefix><Search :size="15" /></template></el-input>
          <el-input v-model="filters.authorName" clearable placeholder="创作者名称"><template #prefix><UserRound :size="15" /></template></el-input>
          <el-select v-model="filters.platform" clearable filterable allow-create placeholder="平台">
            <el-option v-for="item in platforms" :key="item" :label="item" :value="item" />
          </el-select>
          <el-select v-model="filters.kind" clearable filterable allow-create placeholder="资源类型">
            <el-option v-for="item in kinds" :key="item" :label="item" :value="item" />
          </el-select>
          <el-button type="primary" native-type="submit" :loading="loading"><Search :size="15" /> 搜索</el-button>
          <el-button title="重置" @click="reset"><RotateCcw :size="15" /></el-button>
        </form>
        <div v-if="error" class="lfvs-error">{{ error }}</div>
        <resource-table :items="result.items" :loading="loading" />
        <el-pagination
          v-if="result.total > result.pageSize"
          class="lfvs-pagination"
          background
          layout="prev, pager, next, sizes, total"
          :current-page="result.page"
          :page-size="result.pageSize"
          :page-sizes="[25, 50, 100]"
          :total="result.total"
          @current-change="search"
          @size-change="changeSize"
        />
      </main>
    </div>
  </k-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter, useRpc } from '@cordisjs/client'
import { RotateCcw, Search, UserRound } from '@lucide/vue'
import type { Data, Page, ResourceRow } from '../src'
import { errorText } from './common'
import ResourceTable from './resource-table.vue'

const rpc = useRpc<Data>()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const error = ref('')
const options = ref<Array<{ platform: string; kind: string }>>([])
const filters = reactive({
  name: route.query.name ?? '', authorName: route.query.authorName ?? '',
  platform: route.query.platform ?? '', kind: route.query.kind ?? '',
})
const result = reactive<Page<ResourceRow>>({ items: [], total: 0, page: 1, pageSize: 25 })
const platforms = computed(() => [...new Set(options.value.map((item) => item.platform))])
const kinds = computed(() => [...new Set(options.value.filter((item) => !filters.platform || item.platform === filters.platform).map((item) => item.kind))])

async function search(page = result.page) {
  loading.value = true
  error.value = ''
  try {
    Object.assign(result, await rpc.value.searchResources({ ...filters, page, pageSize: result.pageSize }))
    await router.replace({ path: '/lfvs/resources', query: Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) })
  } catch (cause) { error.value = errorText(cause) }
  finally { loading.value = false }
}

function changeSize(size: number) { result.pageSize = size; void search(1) }
function reset() { Object.assign(filters, { name: '', authorName: '', platform: '', kind: '' }); void search(1) }

onMounted(async () => {
  const overview = await rpc.value.overview().catch(() => undefined)
  options.value = overview?.breakdown ?? []
  await search(1)
})
</script>

<style scoped>
.header-count { margin-left: 8px; color: var(--fg3); font-size: 12px; font-weight: 400; }
:deep(.el-button > span) { display: inline-flex; align-items: center; gap: 5px; }
</style>

<template>
  <k-layout>
    <template #header><span>LFVS 创作者</span><span class="header-count">{{ result.total }} 位</span></template>
    <div class="lfvs-page">
      <main class="lfvs-content">
        <form class="lfvs-toolbar" @submit.prevent="search(1)">
          <el-input v-model="filters.name" clearable placeholder="创作者名称"><template #prefix><Search :size="15" /></template></el-input>
          <el-select v-model="filters.platform" clearable filterable allow-create placeholder="平台">
            <el-option v-for="item in platforms" :key="item" :label="item" :value="item" />
          </el-select>
          <el-select v-model="filters.kind" clearable filterable allow-create placeholder="关联资源类型">
            <el-option v-for="item in kinds" :key="item" :label="item" :value="item" />
          </el-select>
          <el-checkbox v-model="filters.includePlaceholders">包含占位创作者</el-checkbox>
          <el-button type="primary" native-type="submit" :loading="loading"><Search :size="15" /> 搜索</el-button>
          <el-button title="重置" @click="reset"><RotateCcw :size="15" /></el-button>
        </form>
        <div v-if="error" class="lfvs-error">{{ error }}</div>
        <author-table :items="result.items" :loading="loading" />
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
import { RotateCcw, Search } from '@lucide/vue'
import type { AuthorRow, Data, Page } from '../src'
import { errorText } from './common'
import AuthorTable from './author-table.vue'

const rpc = useRpc<Data>()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const error = ref('')
const options = ref<Array<{ platform: string; kind: string }>>([])
const filters = reactive({
  name: route.query.name ?? '', platform: route.query.platform ?? '', kind: route.query.kind ?? '',
  includePlaceholders: route.query.includePlaceholders === 'true',
})
const result = reactive<Page<AuthorRow>>({ items: [], total: 0, page: 1, pageSize: 25 })
const platforms = computed(() => [...new Set(options.value.map((item) => item.platform))])
const kinds = computed(() => [...new Set(options.value.filter((item) => !filters.platform || item.platform === filters.platform).map((item) => item.kind))])

async function search(page = result.page) {
  loading.value = true
  error.value = ''
  try {
    Object.assign(result, await rpc.value.searchAuthors({ ...filters, page, pageSize: result.pageSize }))
    await router.replace({
      path: '/lfvs/authors',
      query: {
        ...(filters.name ? { name: filters.name } : {}),
        ...(filters.platform ? { platform: filters.platform } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.includePlaceholders ? { includePlaceholders: 'true' } : {}),
      },
    })
  } catch (cause) { error.value = errorText(cause) }
  finally { loading.value = false }
}

function changeSize(size: number) { result.pageSize = size; void search(1) }
function reset() { Object.assign(filters, { name: '', platform: '', kind: '', includePlaceholders: false }); void search(1) }

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

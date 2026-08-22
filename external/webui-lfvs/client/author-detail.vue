<template>
  <k-layout>
    <template #header><span>创作者详情</span></template>
    <template #menu>
      <el-button text circle title="返回创作者列表" @click="router.push('/lfvs/authors')"><ArrowLeft :size="16" /></el-button>
      <el-button text circle title="刷新" :loading="loading" @click="load"><RefreshCw :size="16" /></el-button>
    </template>
    <div class="lfvs-page">
      <main class="lfvs-content" v-loading="loading">
        <div v-if="error" class="lfvs-error">{{ error }}</div>
        <template v-if="author">
          <section class="author-head">
            <img v-if="author.avatarUrl" :src="author.avatarUrl" alt="" referrerpolicy="no-referrer" />
            <div v-else class="avatar-empty" />
            <div>
              <div class="name-line">
                <h1 class="lfvs-detail-title">{{ author.name || author.id }}</h1>
                <el-tag v-if="author.isPlaceholder" type="warning" size="small">占位创作者</el-tag>
              </div>
              <div class="lfvs-meta-line">
                <span class="lfvs-platform">{{ author.platform }}</span>
                <span>{{ author.id }}</span>
                <span>{{ author.resourceCount }} 个资源</span>
                <span>同步 {{ formatTime(author.lastSyncedAt) }}</span>
              </div>
              <p v-if="author.description" class="lfvs-description">{{ author.description }}</p>
            </div>
          </section>

          <section v-if="Object.keys(author.extension).length" class="lfvs-section">
            <h2 class="lfvs-section-title">扩展信息</h2>
            <dl class="lfvs-key-values">
              <div v-for="(value, key) in author.extension" :key="key"><dt>{{ key }}</dt><dd>{{ displayValue(value) }}</dd></div>
            </dl>
          </section>

          <section class="lfvs-section">
            <div class="resource-heading">
              <h2 class="lfvs-section-title"><span>关联资源</span><span class="lfvs-subtle">{{ resources.total }} 条</span></h2>
              <el-select v-model="kind" clearable filterable allow-create placeholder="全部类型" @change="loadResources(1)">
                <el-option v-for="item in kinds" :key="item" :label="item" :value="item" />
              </el-select>
            </div>
            <resource-table :items="resources.items" :loading="resourceLoading" />
            <el-pagination
              v-if="resources.total > resources.pageSize"
              class="lfvs-pagination"
              background layout="prev, pager, next, total"
              :current-page="resources.page" :page-size="resources.pageSize" :total="resources.total"
              @current-change="loadResources"
            />
          </section>
        </template>
        <div v-else-if="!loading && !error" class="lfvs-empty">创作者不存在</div>
      </main>
    </div>
  </k-layout>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter, useRpc } from '@cordisjs/client'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import type { AuthorDetail, Data, Page, ResourceRow } from '../src'
import { errorText, formatTime } from './common'
import ResourceTable from './resource-table.vue'

const rpc = useRpc<Data>()
const route = useRoute()
const router = useRouter()
const author = ref<AuthorDetail | null>()
const resources = reactive<Page<ResourceRow>>({ items: [], total: 0, page: 1, pageSize: 25 })
const kinds = ref<string[]>([])
const kind = ref('')
const loading = ref(false)
const resourceLoading = ref(false)
const error = ref('')

function key() { return { platform: decodeURIComponent(route.params.platform), id: decodeURIComponent(route.params.id) } }

async function loadResources(page = resources.page) {
  resourceLoading.value = true
  try { Object.assign(resources, await rpc.value.getAuthorResources({ ...key(), kind: kind.value, page, pageSize: resources.pageSize })) }
  catch (cause) { error.value = errorText(cause) }
  finally { resourceLoading.value = false }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const overview = await rpc.value.overview()
    kinds.value = [...new Set(overview.breakdown.filter((item) => item.platform === key().platform).map((item) => item.kind))]
    author.value = await rpc.value.getAuthor({ ...key(), ...(kind.value ? { kind: kind.value } : {}) })
    await loadResources(1)
  } catch (cause) { error.value = errorText(cause) }
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
.author-head { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 24px; align-items: start; }
.author-head > img, .avatar-empty { width: 112px; height: 112px; border-radius: 50%; object-fit: cover; background: #e8ebef; }
.name-line { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.name-line .lfvs-detail-title { margin-bottom: 0; }
.resource-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.resource-heading .lfvs-section-title { margin: 0; }
.resource-heading .el-select { width: 180px; }
@media (max-width: 620px) { .author-head { grid-template-columns: 72px minmax(0, 1fr); gap: 14px; } .author-head > img, .avatar-empty { width: 72px; height: 72px; } }
</style>

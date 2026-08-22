<template>
  <k-card class="vocabili-card">
    <div class="heading">
      <div>
        <h2>Vocabili 导入</h2>
        <p>从最新一期榜单导入本地尚不存在的 Bilibili 视频。</p>
      </div>
      <el-tag :type="status.loggedIn ? 'success' : 'warning'">
        {{ status.loggedIn ? `已登录 ${status.username}` : '未登录' }}
      </el-tag>
    </div>

    <template v-if="!status.loggedIn">
      <el-form label-position="top" class="login-form">
        <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password /></el-form-item>
        <el-form-item label="验证码">
          <div class="captcha-row">
            <el-input v-model="form.codeAnswer" @keyup.enter="login" />
            <button class="captcha" type="button" @click="loadCaptcha">
              <img v-if="captcha.image" :src="captcha.image" alt="Vocabili 验证码" />
              <span v-else>获取验证码</span>
            </button>
          </div>
        </el-form-item>
        <el-button type="primary" :loading="busy" @click="login">登录</el-button>
      </el-form>
    </template>

    <template v-else>
      <div class="stats">
        <div><span>最近完成期数</span><strong>#{{ status.lastIssue || '-' }}</strong></div>
        <div><span>发现视频</span><strong>{{ status.progress.discovered }}</strong></div>
        <div><span>待导入</span><strong>{{ status.progress.missing }}</strong></div>
        <div><span>已导入</span><strong>{{ status.progress.imported }}</strong></div>
      </div>
      <el-progress v-if="status.progress.running" :percentage="progressPercent" />
      <div class="actions">
        <el-button type="primary" :loading="status.progress.running || busy" @click="forceImport">立即导入最新一期</el-button>
        <el-button @click="logout">退出登录</el-button>
      </div>
    </template>

    <p v-if="message" class="message">{{ message }}</p>
  </k-card>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRpc } from '@cordisjs/client'

interface Progress {
  running: boolean
  issue: number
  page: number
  totalPages: number
  discovered: number
  missing: number
  imported: number
}

interface Status {
  loggedIn: boolean
  username: string
  lastIssue: number
  needsReauth: boolean
  progress: Progress
}

interface Rpc {
  status(): Promise<Status>
  captcha(): Promise<{ codeId: string; image: string }>
  login(input: { username: string; password: string; codeId: string; codeAnswer: string }): Promise<void>
  logout(): Promise<void>
  forceImport(): Promise<void>
}

const rpc = useRpc<Rpc>()
const emptyProgress = (): Progress => ({ running: false, issue: 0, page: 0, totalPages: 0, discovered: 0, missing: 0, imported: 0 })
const status = reactive<Status>({ loggedIn: false, username: '', lastIssue: 0, needsReauth: false, progress: emptyProgress() })
const form = reactive({ username: '', password: '', codeAnswer: '' })
const captcha = reactive({ codeId: '', image: '' })
const busy = ref(false)
const message = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const progressPercent = computed(() => {
  if (!status.progress.totalPages) return 0
  return Math.min(100, Math.round(status.progress.page / status.progress.totalPages * 100))
})

function normalizeImage(image: string) {
  return image.startsWith('data:') ? image : `data:image/png;base64,${image}`
}

async function refresh() {
  Object.assign(status, await rpc.value.status())
}

async function loadCaptcha() {
  try {
    message.value = ''
    const result = await rpc.value.captcha()
    captcha.codeId = result.codeId
    captcha.image = normalizeImage(result.image)
  } catch (error: any) {
    message.value = error.message
  }
}

async function login() {
  busy.value = true
  message.value = ''
  try {
    await rpc.value.login({ ...form, codeId: captcha.codeId })
    form.password = ''
    form.codeAnswer = ''
    await refresh()
  } catch (error: any) {
    message.value = error.message
    await loadCaptcha()
  } finally {
    busy.value = false
  }
}

async function logout() {
  await rpc.value.logout()
  await refresh()
  await loadCaptcha()
}

async function forceImport() {
  busy.value = true
  message.value = ''
  try {
    await rpc.value.forceImport()
    message.value = '导入完成'
  } catch (error: any) {
    message.value = error.message
  } finally {
    busy.value = false
    await refresh()
  }
}

onMounted(async () => {
  await refresh()
  if (!status.loggedIn) await loadCaptcha()
  timer = setInterval(() => void refresh(), 2000)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.vocabili-card { margin: 24px; padding: 24px; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
h2 { margin: 0 0 6px; font-size: 22px; }
p { margin: 0; color: var(--fg3); }
.login-form { max-width: 520px; margin-top: 22px; }
.captcha-row { display: flex; width: 100%; gap: 12px; }
.captcha { width: 150px; height: 40px; padding: 0; overflow: hidden; border: 1px solid var(--k-color-divider); border-radius: 6px; background: transparent; cursor: pointer; }
.captcha img { width: 100%; height: 100%; object-fit: contain; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 12px; margin: 24px 0; }
.stats div { padding: 14px; border: 1px solid var(--k-color-divider); border-radius: 8px; }
.stats span { display: block; color: var(--fg3); font-size: 12px; }
.stats strong { display: block; margin-top: 5px; font-size: 22px; }
.actions { display: flex; gap: 10px; margin-top: 18px; }
.message { margin-top: 16px; color: var(--k-color-danger); }
@media (max-width: 720px) { .vocabili-card { margin: 12px; padding: 16px; } .heading { flex-direction: column; } .stats { grid-template-columns: repeat(2, 1fr); } }
</style>

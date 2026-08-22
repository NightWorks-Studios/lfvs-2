import { type Context } from '@cordisjs/client'
import { Activity, LayoutDashboard, Users, Video } from '@lucide/vue'
import { defineComponent, h, type Component } from 'vue'
import OverviewPage from './overview.vue'
import ResourcesPage from './resources.vue'
import ResourceDetailPage from './resource-detail.vue'
import AuthorsPage from './authors.vue'
import AuthorDetailPage from './author-detail.vue'
import RuntimePage from './runtime.vue'
import './styles.scss'

function activityIcon(icon: Component) {
  return defineComponent({
    setup: () => () => h(icon, { size: 20, strokeWidth: 1.8 }),
  })
}

export default function apply(ctx: Context) {
  ctx.client.router.page({
    path: '/lfvs',
    name: 'LFVS 总览',
    icon: activityIcon(LayoutDashboard),
    order: 620,
    component: OverviewPage,
  })
  ctx.client.router.page({
    path: '/lfvs/resources',
    name: 'LFVS 资源',
    icon: activityIcon(Video),
    order: 619,
    component: ResourcesPage,
  })
  ctx.client.router.page({
    path: '/lfvs/authors',
    name: 'LFVS 创作者',
    icon: activityIcon(Users),
    order: 618,
    component: AuthorsPage,
  })
  ctx.client.router.page({
    path: '/lfvs/runtime',
    name: 'LFVS 运行状态',
    icon: activityIcon(Activity),
    order: 617,
    component: RuntimePage,
  })
  ctx.effect(() => ctx.client.router.router.addRoute({
    path: '/lfvs/resources/:platform/:kind/:id',
    name: 'LFVS 资源详情',
    component: ctx.client.wrapComponent(ResourceDetailPage),
    meta: {},
  }))
  ctx.effect(() => ctx.client.router.router.addRoute({
    path: '/lfvs/authors/:platform/:id',
    name: 'LFVS 创作者详情',
    component: ctx.client.wrapComponent(AuthorDetailPage),
    meta: {},
  }))
}

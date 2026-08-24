import { type Context } from '@cordisjs/client'
import VocaloardCard from './vocaloard-card.vue'

export default function apply(ctx: Context) {
  ctx.client.router.slot({
    type: 'home',
    order: 110,
    component: VocaloardCard,
  })
}

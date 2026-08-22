import { type Context } from '@cordisjs/client'
import VocabiliCard from './vocabili-card.vue'

export default function apply(ctx: Context) {
  ctx.client.router.slot({
    type: 'home',
    order: 100,
    component: VocabiliCard,
  })
}

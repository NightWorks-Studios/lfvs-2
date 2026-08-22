<template>
  <div ref="container" class="history-chart" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { FieldInfo, HistoryPoint } from '../src'
import { formatMetric, formatTime } from './common'

echarts.use([LineChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps<{ points: HistoryPoint[]; fields: FieldInfo[]; selected: string[] }>()
const container = ref<HTMLDivElement>()
let chart: echarts.ECharts | undefined
let observer: ResizeObserver | undefined

function render() {
  if (!chart) return
  const fieldMap = new Map(props.fields.map((field) => [field.name, field]))
  chart.setOption({
    animationDuration: 280,
    grid: { left: 18, right: 18, top: 42, bottom: 54, containLabel: true },
    legend: { top: 6, textStyle: { color: '#697281' } },
    tooltip: {
      trigger: 'axis',
      formatter(params: any) {
        const list = Array.isArray(params) ? params : [params]
        if (!list.length) return ''
        const lines = [formatTime(list[0].value[0])]
        for (const item of list) lines.push(`${item.marker}${item.seriesName}: ${formatMetric(item.data.exact)}`)
        return lines.join('<br>')
      },
    },
    xAxis: { type: 'time', axisLabel: { color: '#7b8493' }, axisLine: { lineStyle: { color: '#cfd4dc' } } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#7b8493' }, splitLine: { lineStyle: { color: '#e7e9ed' } } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 10 }],
    series: props.selected.map((name) => ({
      name: fieldMap.get(name)?.label ?? name,
      type: 'line',
      showSymbol: props.points.length < 80,
      symbolSize: 5,
      connectNulls: false,
      sampling: 'lttb',
      data: props.points.map((point) => {
        const exact = point.values[name]
        const numeric = exact === null ? null : Number(exact)
        return { value: [point.capturedAt, Number.isFinite(numeric) ? numeric : null], exact }
      }),
    })),
  }, true)
}

onMounted(() => {
  chart = echarts.init(container.value!)
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(container.value!)
  render()
})
watch(() => [props.points, props.fields, props.selected], render, { deep: true })
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose() })
</script>

<style scoped>
.history-chart { width: 100%; height: 390px; min-height: 390px; }
@media (max-width: 760px) { .history-chart { height: 320px; min-height: 320px; } }
</style>

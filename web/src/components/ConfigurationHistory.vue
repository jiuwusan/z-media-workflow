<script setup>
import { ref,onMounted } from 'vue';
import { api } from '../api/index.js';
const items=ref([]),page=ref(1),total=ref(0),loading=ref(false),error=ref('');
const display=value=>typeof value==='object'?JSON.stringify(value):String(value??'未设置');
async function load(){loading.value=true;error.value='';try{const r=await api(`/config/history?page=${page.value}&pageSize=20`,{quiet:true});items.value=r.items;total.value=r.total;}catch(e){error.value=e.message;}finally{loading.value=false;}}
onMounted(load);
</script>
<template><section class="panel"><div class="panel-header"><h2>配置修改记录</h2><el-button :loading="loading" @click="load">刷新修改记录</el-button></div><div class="panel-body"><el-alert v-if="error" :title="error" type="error" :closable="false" /><el-table :data="items" v-loading="loading"><el-table-column label="时间" width="170"><template #default="{row}">{{new Date(row.createdAt).toLocaleString('zh-CN')}}</template></el-table-column><el-table-column prop="source" label="来源" width="100"/><el-table-column label="变更内容" min-width="260"><template #default="{row}"><div v-for="change in row.changes" :key="change.field" class="change"><strong>{{change.field}}</strong><span>{{display(change.before)}} → {{display(change.after)}}</span></div></template></el-table-column></el-table><el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" @current-change="load" /></div></section></template>
<style scoped>.change{display:flex;gap:12px;flex-wrap:wrap;margin:6px 0;overflow-wrap:anywhere;}.el-pagination{margin-top:16px;}</style>

<script setup>
defineProps({ status: String });
const labels = { queued: '排队中', running: '处理中', completed: '已完成', needs_review: '待确认', failed: '失败' };
const types = { queued: 'info', running: 'primary', completed: 'success', needs_review: 'warning', failed: 'danger' };
</script>
<template><el-tag :type="types[status] || 'info'" effect="light" round>{{ labels[status] || status }}</el-tag></template>

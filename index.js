import { init } from './src/main.js';

const context = SillyTavern.getContext();
context.eventSource.once(context.eventTypes.APP_READY, () => {
  init().catch(error => {
    console.error('[image-hub] 扩展初始化失败', error);
    toastr.error(error.message, 'Image Hub 扩展初始化失败');
  });
});

import { init } from './src/main.js';

const context = SillyTavern.getContext();
context.eventSource.once(context.eventTypes.APP_READY, () => {
  init().catch(error => {
    console.error('[image2] 扩展初始化失败', error);
    toastr.error(error.message, 'image2 扩展初始化失败');
  });
});

const WAND_MENU_ID = 'extensionsMenu';
const SETTINGS_CONTAINER_ID = 'extensions_settings';
const ENTRY_POINT_WAND = 'wand';
const ENTRY_POINT_FLOATING = 'floating';
const LAUNCHER_POSITION_KEY = 'oair_image2_character_reference_launcher_position_v1';
// 位移小于这个距离算点击，超过才算拖拽，免得拖完松手时又触发一次开关面板。
const DRAG_THRESHOLD = 4;

// ST 的扩展设置抽屉结构，展开/收起由酒馆自己的 .inline-drawer-toggle 事件委托处理。
const SETTINGS_DRAWER_HTML = `
<div id="oair_settings" class="oair-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>image2 角色参考图</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label>生图入口</label>
      <label class="checkbox_label flexWrap alignItemsCenter" for="oair_entry_wand">
        <input id="oair_entry_wand" type="radio" name="oair_entry_point" value="${ENTRY_POINT_WAND}" data-oair-setting="entryPoint">
        <span>输入框旁边的魔法棒</span>
      </label>
      <label class="checkbox_label flexWrap alignItemsCenter" for="oair_entry_floating">
        <input id="oair_entry_floating" type="radio" name="oair_entry_point" value="${ENTRY_POINT_FLOATING}" data-oair-setting="entryPoint">
        <span>可拖拽悬浮窗</span>
      </label>
      <button id="oair_reset_launcher_position" class="menu_button" type="button">重置悬浮窗位置</button>
      <small class="oair-entry-hint">魔法棒：酒馆扩展菜单里打开面板。悬浮窗：右下角常驻按钮，按住可以拖到屏幕任意位置。两者都是点击切换面板显示，打开后的面板都可以拖动和缩放。</small>
    </div>
  </div>
</div>`;

export function createEntries({ doc, onToggle, onChange }) {
  const win = doc.defaultView || window;
  let launcher = null;
  let launcherPosition = null;
  let dragged = false;
  let wandItem = null;
  let drawer = null;
  let resetButton = null;

  const mountSettingsDrawer = () => {
    const container = doc.getElementById(SETTINGS_CONTAINER_ID);
    if (!container) {
      console.warn('[image2] 没有找到酒馆的扩展设置容器，生图入口设置无法挂载');
      return;
    }
    const holder = doc.createElement('div');
    holder.innerHTML = SETTINGS_DRAWER_HTML;
    drawer = holder.firstElementChild;
    const onRadioChange = event => {
      if (!event.target.checked) return;
      onChange(event.target.value);
    };
    drawer.querySelectorAll('input[name="oair_entry_point"]').forEach(input => {
      input.addEventListener('change', onRadioChange);
    });
    resetButton = drawer.querySelector('#oair_reset_launcher_position');
    resetButton.addEventListener('click', resetLauncherPosition);
    container.append(drawer);
  };

  const clampLauncherPosition = position => {
    const rect = launcher.getBoundingClientRect();
    return {
      left: Math.min(Math.max(position.left, 0), Math.max(0, win.innerWidth - rect.width)),
      top: Math.min(Math.max(position.top, 0), Math.max(0, win.innerHeight - rect.height)),
    };
  };

  // 没拖动过就贴在右下角，并按布局视口补偿浏览器底栏和软键盘；拖动过则固定为 left/top。
  const applyLauncherPosition = () => {
    if (!launcher) return;
    if (!launcherPosition) {
      launcher.style.left = '';
      launcher.style.top = '';
      launcher.style.right = '';
      const viewport = win.visualViewport;
      const occluded = viewport ? Math.max(0, win.innerHeight - viewport.height - viewport.offsetTop) : 0;
      launcher.style.bottom = `calc(${16 + occluded}px + env(safe-area-inset-bottom, 0px))`;
      return;
    }
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
    launcher.style.left = `${launcherPosition.left}px`;
    launcher.style.top = `${launcherPosition.top}px`;
  };

  // 视口变化时把拖到屏幕外的位置收回来。
  const onViewportChange = () => {
    if (!launcher || !launcherPosition) {
      applyLauncherPosition();
      return;
    }
    launcherPosition = clampLauncherPosition(launcherPosition);
    applyLauncherPosition();
  };

  const readStoredLauncherPosition = () => {
    try {
      const saved = JSON.parse(win.localStorage.getItem(LAUNCHER_POSITION_KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        return { left: saved.left, top: saved.top };
      }
    } catch {
      // 记录损坏时忽略，回到右下角。
    }
    return null;
  };

  const persistLauncherPosition = () => {
    try {
      win.localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify(launcherPosition));
    } catch {
      // 存储不可用时只在本次会话内保持位置。
    }
  };

  // 清掉记录的位置，按钮回到右下角默认位置；悬浮窗没挂载时也照样清记录。
  const resetLauncherPosition = () => {
    launcherPosition = null;
    try {
      win.localStorage.removeItem(LAUNCHER_POSITION_KEY);
    } catch {
      // 存储不可用时只在本次会话内忽略。
    }
    applyLauncherPosition();
  };

  const enableLauncherDrag = () => {
    let drag = null;
    const onPointerDown = event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const rect = launcher.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      dragged = false;
      launcher.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!dragged && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      launcher.classList.add('oair-launcher-dragging');
      launcherPosition = clampLauncherPosition({ left: drag.left + dx, top: drag.top + dy });
      applyLauncherPosition();
    };
    const onPointerUp = () => {
      if (!drag) return;
      drag = null;
      launcher.classList.remove('oair-launcher-dragging');
      if (dragged) persistLauncherPosition();
    };
    launcher.addEventListener('pointerdown', onPointerDown);
    launcher.addEventListener('pointermove', onPointerMove);
    launcher.addEventListener('pointerup', onPointerUp);
    launcher.addEventListener('pointercancel', onPointerUp);
  };

  const attachLauncher = () => {
    if (launcher) return;
    launcher = doc.createElement('button');
    launcher.id = 'oair_launcher';
    launcher.type = 'button';
    launcher.textContent = 'image2 参考图';
    launcher.title = '点击开关面板，按住可以拖到别处';
    launcher.addEventListener('click', () => {
      if (dragged) {
        dragged = false;
        return;
      }
      onToggle();
    });
    doc.body.append(launcher);
    launcherPosition = readStoredLauncherPosition();
    applyLauncherPosition();
    enableLauncherDrag();
  };

  const detachLauncher = () => {
    launcher?.remove();
    launcher = null;
    launcherPosition = null;
    dragged = false;
  };

  const attachWandItem = () => {
    if (wandItem) return;
    const menu = doc.getElementById(WAND_MENU_ID);
    if (!menu) {
      console.warn('[image2] 没有找到酒馆的扩展菜单，魔法棒入口无法挂载');
      return;
    }
    wandItem = doc.createElement('div');
    wandItem.id = 'oair_wand_entry';
    wandItem.className = 'list-group-item flex-container flexGap5';
    const icon = doc.createElement('div');
    icon.className = 'fa-solid fa-image extensionsMenuExtensionButton';
    const label = doc.createElement('span');
    label.textContent = 'image2 参考图';
    wandItem.append(icon, label);
    wandItem.addEventListener('click', onToggle);
    menu.append(wandItem);
  };

  const detachWandItem = () => {
    wandItem?.removeEventListener('click', onToggle);
    wandItem?.remove();
    wandItem = null;
  };

  const apply = entryPoint => {
    const floatingEntry = entryPoint === ENTRY_POINT_FLOATING;
    // 位置只在悬浮窗模式有意义，魔法棒模式下禁用重置按钮。
    if (resetButton) {
      resetButton.disabled = !floatingEntry;
      resetButton.title = floatingEntry ? '把悬浮窗按钮放回右下角初始位置' : '切换到悬浮窗入口后才能重置位置';
    }
    if (floatingEntry) {
      attachLauncher();
      detachWandItem();
    } else {
      attachWandItem();
      detachLauncher();
    }
  };

  const destroy = () => {
    detachLauncher();
    detachWandItem();
    drawer?.remove();
    drawer = null;
    resetButton = null;
    win.removeEventListener('resize', onViewportChange);
    win.removeEventListener('orientationchange', onViewportChange);
    win.visualViewport?.removeEventListener('resize', onViewportChange);
    win.visualViewport?.removeEventListener('scroll', onViewportChange);
  };

  mountSettingsDrawer();
  win.addEventListener('resize', onViewportChange);
  win.addEventListener('orientationchange', onViewportChange);
  win.visualViewport?.addEventListener('resize', onViewportChange);
  win.visualViewport?.addEventListener('scroll', onViewportChange);

  return { apply, destroy };
}

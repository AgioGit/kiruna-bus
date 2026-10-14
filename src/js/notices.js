const notices = new WeakMap();
const NOTICE_DURATION_MS = 10000;
const FADE_DURATION_MS = 300;

export function showNotice(element, message, { transient = false, onDismiss } = {}) {
  if (!element) return;
  const previous = notices.get(element);
  if (previous?.message === message && previous.transient === transient) return;
  clearTimeout(previous?.timer);
  const notice = { message, transient };
  notices.set(element, notice);
  element.classList.add('notice');
  element.classList.remove('notice-fading');
  element.textContent = message;
  element.hidden = !message;
  if (!message || !transient) return;

  notice.timer = setTimeout(() => {
    if (notices.get(element) !== notice) return;
    element.classList.add('notice-fading');
    notice.timer = setTimeout(() => {
      if (notices.get(element) !== notice) return;
      element.hidden = true;
      element.textContent = '';
      notices.delete(element);
      onDismiss?.();
    }, FADE_DURATION_MS);
    notice.timer?.unref?.();
  }, NOTICE_DURATION_MS);
  notice.timer?.unref?.();
}

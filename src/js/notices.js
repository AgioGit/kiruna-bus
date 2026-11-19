import { formatMessage } from './i18n.js';

const notices = new WeakMap();
const NOTICE_DURATION_MS = 10000;
const FADE_DURATION_MS = 300;

export function showNotice(element, message, { transient = false, onDismiss } = {}) {
  if (!element) return;
  const previous = notices.get(element);
  const text = formatMessage(message);
  if (previous?.text === text && previous.transient === transient) {
    previous.message = message;
    return;
  }
  clearTimeout(previous?.timer);
  const notice = { message, text, transient };
  notices.set(element, notice);
  element.classList.add('notice');
  element.classList.remove('notice-fading');
  element.textContent = text;
  element.hidden = !text;
  if (!text || !transient) return;

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

// Change only the text; the original dismiss callback and deadline still apply.
export function refreshNotice(element) {
  const notice = notices.get(element);
  if (!notice || element.hidden) return;
  const text = formatMessage(notice.message);
  if (text !== notice.text) element.textContent = notice.text = text;
}

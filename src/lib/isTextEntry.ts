/** True when a key event comes from a field the player is typing in, so global shortcuts must stay out. */
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

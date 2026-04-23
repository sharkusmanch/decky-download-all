export interface DebouncedFn {
  (): void;
  cancel: () => void;
}

export const trailingDebounce = (fn: () => void, waitMs: number): DebouncedFn => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
  (debounced as DebouncedFn).cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced as DebouncedFn;
};

/**
 * Read a text field from a submitted form.
 *
 * `FormData.get` returns a string, a `File` or null. Passing the result to
 * `String()` turns a file into "[object File]" and stores it as if it were the
 * value somebody typed, so anything that is not text is treated as absent.
 */
export function textField(form: FormData, name: string, fallback = ''): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : fallback;
}

/**
 * Run a promise-returning handler from a DOM event, which expects no return
 * value. Without this the promise is handed straight to the attribute and a
 * rejection becomes an unhandled rejection rather than anything the page shows.
 */
export function handle(action: () => Promise<unknown>): () => void {
  return () => {
    void action();
  };
}

/** Ordinary arithmetic in a local, isolated synthetic evaluation fixture. */
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

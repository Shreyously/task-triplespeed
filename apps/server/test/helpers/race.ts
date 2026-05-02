export async function runConcurrent<T>(count: number, fn: (index: number) => Promise<T>) {
  const tasks = Array.from({ length: count }, (_, index) => fn(index));
  return Promise.allSettled(tasks);
}

export function countFulfilled<T>(results: PromiseSettledResult<T>[]) {
  return results.filter((r) => r.status === "fulfilled").length;
}

export function countRejected<T>(results: PromiseSettledResult<T>[]) {
  return results.filter((r) => r.status === "rejected").length;
}

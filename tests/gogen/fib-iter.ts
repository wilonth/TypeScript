export function fib(n: number): number {
  let fib: number[] = [0, 1]
  for (let i = 2; i <= n; i++) {
    fib[i] = fib[i-1] + fib[i-2]
  }
  return fib[n]
}

console.log(fib(1000))

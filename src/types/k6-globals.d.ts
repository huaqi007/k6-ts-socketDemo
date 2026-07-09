// k6 运行时注入的全局对象，TypeScript 默认不识别，这里补充声明以通过类型检查
declare var console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
};

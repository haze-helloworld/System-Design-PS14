export const n0 = (v: number) => (v >= 10000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toLocaleString());
export const ms = (v: number) => (v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms');
export const pc = (v: number) => Math.round(v * 100) + '%';
export const rate = (v: number) => (v >= 100 ? n0(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '/s';

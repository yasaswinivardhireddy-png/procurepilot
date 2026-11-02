const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Amounts are integer paise. formatInr(29900) === '₹299.00'
export function formatInr(paise: number): string {
  return inr.format(paise / 100);
}

export function formatInrWhole(paise: number): string {
  return inrWhole.format(Math.round(paise / 100));
}

export function formatPercentBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

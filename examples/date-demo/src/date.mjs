export function isValidDate(year, month, day) {
  return Number.isInteger(year) && year >= 1
    && Number.isInteger(month) && month >= 1 && month <= 12
    && Number.isInteger(day) && day >= 1 && day <= 31;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 3 && isValidDate(...args.map(Number))) {
    console.log('valid');
  } else {
    console.error('invalid date');
    process.exitCode = 1;
  }
}

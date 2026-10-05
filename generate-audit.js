const fs = require('fs');

const files = [
  'apps/api/src/routes/course/verify.ts',
  'packages/core/src/services/course/payment.ts',
  'packages/core/src/services/course/purchase.ts',
  'apps/api/src/__tests__/course-payment-verify-route.test.ts',
  'apps/api/src/__tests__/course-payment-processing.test.ts',
  'apps/api/src/__tests__/purchase-concurrency.test.ts'
];

let output = '';

for (const file of files) {
  output += `==================================================\n`;
  output += `FILE: ${file}\n`;
  output += `=====================\n\n`;
  output += fs.readFileSync(file, 'utf8');
  output += `\n==================================================\n`;
  output += `END FILE\n`;
  output += `========\n\n`;
}

fs.writeFileSync('STEP4_FINAL_CHANGED_FILES.txt', output);

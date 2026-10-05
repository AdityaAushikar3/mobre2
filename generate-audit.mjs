import fs from 'fs';

const files = [
  'apps/api/src/__tests__/course-payment-processing.test.ts',
  'apps/api/src/__tests__/course-payment-verify-route.test.ts',
  'apps/api/src/__tests__/purchase-concurrency.test.ts',
  'apps/api/src/routes/course/verify.ts',
  'packages/core/src/services/course/payment.ts',
  'packages/core/src/services/course/purchase.ts',
  'packages/db/src/queries/auth/profile.ts',
  'apps/api/src/services/course/payment.ts'
];

let output = '';
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  output += `==================================================\n`;
  output += `FILE: ${file}\n`;
  output += `=====================\n\n`;
  output += content;
  if (!content.endsWith('\n')) {
    output += '\n';
  }
  output += `\n==================================================\n`;
  output += `END FILE\n`;
  output += `========\n\n`;
}

fs.writeFileSync('STEP4_FINAL_CHANGED_FILES.txt', output);
console.log('Audit file generated.');

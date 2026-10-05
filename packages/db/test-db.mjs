import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/classroomio' });

async function run() {
  await client.connect();

  const org = await client.query(
    `INSERT INTO organization (name, "siteName", is_restricted, ai_tutor_settings) VALUES ('Test Org', 'testorg_${Date.now()}', false, '{}') RETURNING id`
  );
  const orgId = org.rows[0].id;

  const user = await client.query(
    `INSERT INTO "user" (name, email) VALUES ('Test User', 'test_${Date.now()}@test.com') RETURNING id`
  );
  const userId = user.rows[0].id;

  const group = await client.query(
    `INSERT INTO "group" (name, organization_id) VALUES ('Test Group', '${orgId}') RETURNING id`
  );
  const groupId = group.rows[0].id;

  const course = await client.query(
    `INSERT INTO course (title, description, group_id, is_template, logo, currency, public_for_all) VALUES ('Test Course', 'test description', '${groupId}', false, '', 'INR', false) RETURNING id`
  );
  const courseId = course.rows[0].id;

  console.log('Setup OK:', { orgId, userId, courseId });

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id) VALUES ('${orgId}', '${userId}', '${courseId}', 99900, 'order_123_${Date.now()}')`
    );
    console.log('amountPaise = 99900\n→ accepted');
  } catch (e) {
    console.log('Positive amount failed:', e.message);
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id) VALUES ('${orgId}', '${userId}', '${courseId}', 0, 'order_2_${Date.now()}')`
    );
    console.log('amountPaise = 0 -> accepted (FAIL)');
  } catch (e) {
    console.log(
      'amountPaise = 0\n→ rejected',
      e.message.includes('course_order_amount_paise_check') ? '(check constraint)' : e.message
    );
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id) VALUES ('${orgId}', '${userId}', '${courseId}', -100, 'order_3_${Date.now()}')`
    );
    console.log('amountPaise = -100 -> accepted (FAIL)');
  } catch (e) {
    console.log(
      'amountPaise < 0\n→ rejected',
      e.message.includes('course_order_amount_paise_check') ? '(check constraint)' : e.message
    );
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, currency) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_4_${Date.now()}', 'USD')`
    );
    console.log('Invalid currency USD -> accepted (FAIL)');
  } catch (e) {
    console.log(
      'USD\n→ rejected',
      e.message.includes('course_order_currency_check') ? '(check constraint)' : e.message
    );
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, currency) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_4_inr_${Date.now()}', 'INR')`
    );
    console.log('INR\n→ accepted');
  } catch (e) {
    console.log('INR -> rejected (FAIL)', e.message);
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, razorpay_payment_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_5_${Date.now()}', 'pay_123')`
    );
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, razorpay_payment_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_6_${Date.now()}', 'pay_123')`
    );
    console.log('pay_123\npay_123\n→ accepted (FAIL)');
  } catch (e) {
    console.log(
      'pay_123\npay_123\n→ rejected',
      e.message.includes('course_order_razorpay_payment_id_unique') ? '(unique constraint)' : e.message
    );
  }

  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, razorpay_payment_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_7_${Date.now()}', NULL)`
    );
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id, razorpay_payment_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, 'order_8_${Date.now()}', NULL)`
    );
    console.log('NULL\nNULL\n→ allowed');
  } catch (e) {
    console.log('NULL NULL -> rejected (FAIL):', e.message);
  }

  const orderId9 = 'order_9_' + Date.now();
  try {
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, '${orderId9}')`
    );
    await client.query(
      `INSERT INTO course_order (organization_id, user_id, course_id, amount_paise, razorpay_order_id) VALUES ('${orgId}', '${userId}', '${courseId}', 100, '${orderId9}')`
    );
    console.log('order_123\norder_123\n→ accepted (FAIL)');
  } catch (e) {
    console.log(
      'order_123\norder_123\n→ rejected',
      e.message.includes('course_order_razorpay_order_id_key') ? '(unique constraint)' : e.message
    );
  }

  // Check FK restrict
  try {
    await client.query(`DELETE FROM course WHERE id = '${courseId}'`);
    console.log('Course deletion -> accepted (FAIL)');
  } catch (e) {
    console.log(
      'Foreign key deletion restricted:',
      e.message.includes('course_order_course_id_fkey') ? 'Yes' : e.message
    );
  }

  // Check index existence
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'course_order'`);
  const hasUserCourseIndex = indexes.rows.some((r) => r.indexname === 'idx_course_order_user_course');
  console.log('(userId, courseId) index exists:', hasUserCourseIndex ? 'Yes' : 'No');

  await client.end();
}

run().catch(console.error);

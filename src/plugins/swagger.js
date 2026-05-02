function jsonSchema(properties = {}, required = []) {
  return { type: 'object', required, properties, additionalProperties: true };
}

function successResponse(description = 'Successful response') {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
      },
    },
  };
}

function errorResponse(description = 'Error response') {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            code: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
      },
    },
  };
}

function authHeader() {
  return [{ bearerAuth: [] }];
}

function pathParam(name) {
  return { name, in: 'path', required: true, schema: { type: 'string' } };
}

function body(content) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: content || jsonSchema(),
      },
    },
  };
}

function genericOperation({ tag, summary, auth = true, params = [], requestBody = null, responses = null }) {
  const op = {
    tags: [tag],
    summary,
    responses: responses || {
      200: successResponse(),
      201: successResponse('Created'),
      400: errorResponse('Bad request'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      500: errorResponse('Server error'),
    },
  };
  if (auth) op.security = authHeader();
  if (params.length) op.parameters = params;
  if (requestBody) op.requestBody = requestBody;
  return op;
}

function add(paths, method, route, options) {
  if (!paths[route]) paths[route] = {};
  paths[route][method] = genericOperation(options);
}

function addCrud(paths, base, tag, singular) {
  add(paths, 'get', base, { tag, summary: `List ${tag.toLowerCase()}`, auth: false });
  add(paths, 'post', base, { tag, summary: `Create ${singular}`, requestBody: body() });
  add(paths, 'get', `${base}/{id}`, { tag, summary: `Get ${singular}`, auth: false, params: [pathParam('id')] });
  add(paths, 'put', `${base}/{id}`, { tag, summary: `Update ${singular}`, params: [pathParam('id')], requestBody: body() });
  add(paths, 'delete', `${base}/{id}`, { tag, summary: `Delete ${singular}`, params: [pathParam('id')] });
}

function addAuthRoutes(paths) {
  const tag = 'Auth';
  add(paths, 'post', '/api/auth/register', {
    tag,
    auth: false,
    summary: 'Register a user and start registration verification',
    requestBody: body(jsonSchema({
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      googleIdToken: { type: 'string' },
    }, ['email'])),
  });
  add(paths, 'post', '/api/auth/login', {
    tag,
    auth: false,
    summary: 'Login and receive a JWT',
    requestBody: body(jsonSchema({
      email: { type: 'string', format: 'email' },
      password: { type: 'string' },
    }, ['email', 'password'])),
  });
  add(paths, 'post', '/api/auth/guest', { tag, auth: false, summary: 'Create or login as guest user', requestBody: body() });
  add(paths, 'post', '/api/auth/oauth/google', {
    tag,
    auth: false,
    summary: 'Login or register with Google',
    requestBody: body(jsonSchema({ idToken: { type: 'string' }, id_token: { type: 'string' }, role: { type: 'string' } })),
  });
  add(paths, 'get', '/api/auth/google/callback', { tag, auth: false, summary: 'Google OAuth callback' });
  add(paths, 'post', '/api/auth/oauth/apple', {
    tag,
    auth: false,
    summary: 'Login or register with Apple',
    requestBody: body(jsonSchema({
      identityToken: { type: 'string' },
      nonce: { type: 'string' },
      authorizationCode: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string' },
    })),
  });
  add(paths, 'post', '/api/auth/forgot-password', { tag, auth: false, summary: 'Request password reset token', requestBody: body(jsonSchema({ email: { type: 'string', format: 'email' } }, ['email'])) });
  add(paths, 'post', '/api/auth/reset-password', { tag, auth: false, summary: 'Reset password with token', requestBody: body(jsonSchema({ resetToken: { type: 'string' }, newPassword: { type: 'string', minLength: 6 } }, ['resetToken', 'newPassword'])) });
  add(paths, 'post', '/api/auth/verify-otp', { tag, auth: false, summary: 'Verify registration OTP', requestBody: body(jsonSchema({ email: { type: 'string', format: 'email' }, otp: { type: 'string' } }, ['email', 'otp'])) });
  add(paths, 'post', '/api/auth/resend-otp', { tag, auth: false, summary: 'Resend registration OTP', requestBody: body(jsonSchema({ email: { type: 'string', format: 'email' }, phone: { type: 'string' } }, ['email'])) });
  add(paths, 'post', '/api/auth/verify-sendchamp', { tag, auth: false, summary: 'Verify Sendchamp OTP/reference', requestBody: body(jsonSchema({ email: { type: 'string', format: 'email' }, reference: { type: 'string' }, otp: { type: 'string' } }, ['email', 'reference', 'otp'])) });
  add(paths, 'post', '/api/auth/registeruserfirebase', { tag, auth: false, summary: 'Register user using Firebase phone verification', requestBody: body() });
  add(paths, 'post', '/api/auth/verify-remote', { tag, auth: false, summary: 'Verify remote token', requestBody: body(jsonSchema({ token: { type: 'string' } })) });
  add(paths, 'get', '/api/auth/verify', { tag, summary: 'Verify JWT and return decoded payload' });
}

function addKycRoutes(paths) {
  const tag = 'KYC';
  add(paths, 'post', '/api/kyc/dojah/nin-selfie', {
    tag,
    summary: 'Verify Nigerian NIN with selfie through Dojah',
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/DojahNinSelfieJsonRequest' } },
        'multipart/form-data': { schema: { $ref: '#/components/schemas/DojahNinSelfieMultipartRequest' } },
      },
    },
    responses: {
      200: { description: 'Verification completed', content: { 'application/json': { schema: { $ref: '#/components/schemas/DojahNinSelfieResponse' } } } },
      202: successResponse('Automatic verification moved to manual review'),
      400: errorResponse('Invalid NIN or missing selfie'),
      401: errorResponse('Missing or invalid JWT'),
      500: errorResponse('Dojah configuration or server error'),
    },
  });
  add(paths, 'post', '/api/kyc/submit', { tag, summary: 'Submit manual KYC fallback', requestBody: body() });
  add(paths, 'get', '/api/kyc/status', { tag, summary: 'Get current user KYC status' });
  add(paths, 'delete', '/api/kyc/{id}/file', { tag, summary: 'Delete uploaded KYC file', params: [pathParam('id')] });
}

function addApplicationRoutes(paths) {
  addCrud(paths, '/api/ads', 'Ads', 'ad');
  addCrud(paths, '/api/announcements/ads', 'Ads', 'announcement ad');
  for (const base of ['/api/ads', '/api/announcements/ads']) {
    add(paths, 'get', `${base}/marquee`, { tag: 'Ads', auth: false, summary: 'Get marquee ad' });
    add(paths, 'post', `${base}/marquee`, { tag: 'Ads', summary: 'Create or update marquee ad', requestBody: body() });
    add(paths, 'get', `${base}/banner`, { tag: 'Ads', auth: false, summary: 'List banner ads' });
    add(paths, 'post', `${base}/banner`, { tag: 'Ads', summary: 'Create banner ad', requestBody: body() });
    add(paths, 'get', `${base}/carousel`, { tag: 'Ads', auth: false, summary: 'List carousel ads' });
    add(paths, 'post', `${base}/carousel`, { tag: 'Ads', summary: 'Create carousel ad', requestBody: body() });
  }

  add(paths, 'get', '/api/artisans', { tag: 'Artisans', auth: false, summary: 'List/discover artisans' });
  add(paths, 'get', '/api/artisans/search', { tag: 'Artisans', auth: false, summary: 'Search artisans' });
  add(paths, 'get', '/api/artisans/user/{id}', { tag: 'Artisans', auth: false, summary: 'Get artisan profile by user id', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisans/me', { tag: 'Artisans', summary: 'Update authenticated artisan profile', requestBody: body() });
  add(paths, 'post', '/api/artisans', { tag: 'Artisans', summary: 'Create artisan profile', requestBody: body() });
  add(paths, 'get', '/api/artisans/{id}', { tag: 'Artisans', auth: false, summary: 'Get artisan profile', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisans/{id}', { tag: 'Artisans', summary: 'Update artisan profile', params: [pathParam('id')], requestBody: body() });
  add(paths, 'patch', '/api/artisans/{id}/verify', { tag: 'Artisans', summary: 'Admin verify artisan', params: [pathParam('id')] });
  add(paths, 'patch', '/api/artisans/{id}/unverify', { tag: 'Artisans', summary: 'Admin unverify artisan', params: [pathParam('id')] });

  add(paths, 'get', '/api/artisan-services/artisan/{artisanId}', { tag: 'Artisan Services', auth: false, summary: 'List services for artisan', params: [pathParam('artisanId')] });
  add(paths, 'post', '/api/artisan-services', { tag: 'Artisan Services', summary: 'Create or update artisan services/prices', requestBody: body() });
  add(paths, 'get', '/api/artisan-services/me', { tag: 'Artisan Services', summary: 'List my artisan services' });
  add(paths, 'get', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Get artisan service', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Update artisan service', params: [pathParam('id')], requestBody: body() });
  add(paths, 'delete', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Delete artisan service', params: [pathParam('id')] });

  add(paths, 'get', '/api/chat/booking/{bookingId}', { tag: 'Chat', summary: 'Fetch chat thread by booking', params: [pathParam('bookingId')] });
  add(paths, 'get', '/api/chat/{threadId}', { tag: 'Chat', summary: 'Fetch chat thread', params: [pathParam('threadId')] });
  add(paths, 'post', '/api/chat/{threadId}', { tag: 'Chat', summary: 'Send chat message', params: [pathParam('threadId')], requestBody: body() });

  add(paths, 'get', '/api/locations/nigeria/states', { tag: 'Locations', auth: false, summary: 'List Nigerian states' });
  add(paths, 'get', '/api/locations/nigeria/lgas', { tag: 'Locations', auth: false, summary: 'List LGAs for a Nigerian state' });

  addCrud(paths, '/api/job-categories', 'Job Categories', 'job category');
  addCrud(paths, '/api/job-subcategories', 'Job Subcategories', 'job subcategory');

  add(paths, 'get', '/api/jobs/mine', { tag: 'Jobs', summary: 'List authenticated customer jobs' });
  add(paths, 'get', '/api/jobs', { tag: 'Jobs', summary: 'List jobs' });
  add(paths, 'post', '/api/jobs', { tag: 'Jobs', summary: 'Create job', requestBody: body() });
  add(paths, 'get', '/api/jobs/{id}', { tag: 'Jobs', auth: false, summary: 'Get job', params: [pathParam('id')] });
  add(paths, 'put', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Update job', params: [pathParam('id')], requestBody: body() });
  add(paths, 'patch', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Patch job', params: [pathParam('id')], requestBody: body() });
  add(paths, 'delete', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Close/delete job', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/apply', { tag: 'Jobs', summary: 'Apply to job as verified artisan', params: [pathParam('id')], requestBody: body() });
  add(paths, 'get', '/api/jobs/{id}/applications', { tag: 'Jobs', summary: 'List job applications', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/applications/{appId}/accept', { tag: 'Jobs', summary: 'Accept job application', params: [pathParam('id'), pathParam('appId')], requestBody: body() });
  add(paths, 'patch', '/api/jobs/{id}/applications/{appId}', { tag: 'Jobs', summary: 'Update job application', params: [pathParam('id'), pathParam('appId')], requestBody: body() });
  add(paths, 'post', '/api/jobs/{id}/applications/{appId}/withdraw', { tag: 'Jobs', summary: 'Withdraw job application', params: [pathParam('id'), pathParam('appId')] });
  add(paths, 'post', '/api/jobs/{id}/attachments', { tag: 'Jobs', summary: 'Upload job attachment', params: [pathParam('id')] });
  add(paths, 'delete', '/api/jobs/{id}/attachments', { tag: 'Jobs', summary: 'Delete job attachment', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/quotes', { tag: 'Jobs', summary: 'Create job quote', params: [pathParam('id')], requestBody: body() });
  add(paths, 'get', '/api/jobs/{id}/quotes', { tag: 'Jobs', summary: 'List job quotes', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/quotes/{quoteId}/accept', { tag: 'Jobs', summary: 'Accept job quote', params: [pathParam('id'), pathParam('quoteId')], requestBody: body() });
}

function addBookingAndPaymentRoutes(paths) {
  add(paths, 'get', '/api/bookings', { tag: 'Bookings', summary: 'List bookings' });
  add(paths, 'post', '/api/bookings', { tag: 'Bookings', summary: 'Create booking', requestBody: body() });
  add(paths, 'get', '/api/bookings/customer/{customerId}', { tag: 'Bookings', summary: 'List customer bookings', params: [pathParam('customerId')] });
  add(paths, 'get', '/api/bookings/artisan/{artisanId}', { tag: 'Bookings', summary: 'List artisan bookings', params: [pathParam('artisanId')] });
  add(paths, 'get', '/api/bookings/{id}', { tag: 'Bookings', summary: 'Get booking', params: [pathParam('id')] });
  add(paths, 'delete', '/api/bookings/{id}', { tag: 'Bookings', summary: 'Cancel booking', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/artisan-cancel', { tag: 'Bookings', summary: 'Cancel booking as verified artisan', params: [pathParam('id')], requestBody: body() });
  add(paths, 'get', '/api/bookings/{id}/refund', { tag: 'Bookings', summary: 'Get booking refund status', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/hire', { tag: 'Bookings', summary: 'Hire artisan and initialize payment when needed', requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/pay-after-completion', { tag: 'Bookings', summary: 'Pay deferred booking after completion', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/complete', { tag: 'Bookings', summary: 'Complete booking', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/accept', { tag: 'Bookings', summary: 'Accept booking as verified artisan', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/reject', { tag: 'Bookings', summary: 'Reject booking as verified artisan', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/requirements', { tag: 'Bookings', summary: 'Post booking requirement', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/quotes', { tag: 'Bookings', summary: 'Create booking quote as verified artisan', params: [pathParam('id')], requestBody: body() });
  add(paths, 'get', '/api/bookings/{id}/quotes', { tag: 'Bookings', summary: 'List booking quotes', params: [pathParam('id')] });
  add(paths, 'get', '/api/bookings/{id}/quotes/details', { tag: 'Bookings', summary: 'List detailed booking quotes', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/quotes/{quoteId}/accept', { tag: 'Bookings', summary: 'Accept booking quote', params: [pathParam('id'), pathParam('quoteId')], requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/pay-with-quote', { tag: 'Bookings', summary: 'Pay booking with accepted quote', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/bookings/{id}/confirm-payment', { tag: 'Bookings', summary: 'Confirm booking payment', params: [pathParam('id')] });

  add(paths, 'post', '/api/payments', { tag: 'Payments', summary: 'Create payment record', requestBody: body() });
  add(paths, 'post', '/api/payments/verify', { tag: 'Payments', summary: 'Verify payment', requestBody: body() });
  add(paths, 'post', '/api/payments/webhook', { tag: 'Payments', auth: false, summary: 'Paystack webhook endpoint', requestBody: body() });
  add(paths, 'post', '/api/payments/reconcile/pending-quotes', { tag: 'Payments', summary: 'Admin reconcile pending quote transactions' });
  add(paths, 'post', '/api/payments/initialize', { tag: 'Payments', summary: 'Initialize Paystack transaction', requestBody: body() });
  add(paths, 'get', '/api/payments/callback', { tag: 'Payments', auth: false, summary: 'Paystack callback endpoint' });
  add(paths, 'get', '/api/payments', { tag: 'Payments', summary: 'List payments' });
  add(paths, 'get', '/api/payments/banks', { tag: 'Payments', summary: 'List Paystack banks' });
  add(paths, 'get', '/api/payments/banks/resolve', { tag: 'Payments', summary: 'Resolve Paystack account' });

  add(paths, 'get', '/api/wallet', { tag: 'Wallet', summary: 'Get wallet' });
  add(paths, 'post', '/api/wallet/credit', { tag: 'Wallet', summary: 'Credit wallet', requestBody: body() });
  add(paths, 'post', '/api/wallet/debit', { tag: 'Wallet', summary: 'Debit wallet', requestBody: body() });
  add(paths, 'post', '/api/wallet/payout-details', { tag: 'Wallet', summary: 'Set payout details', requestBody: body() });
  add(paths, 'get', '/api/wallet/payout-details', { tag: 'Wallet', summary: 'Get payout details' });
}

function addCommsAndUserRoutes(paths) {
  add(paths, 'post', '/api/devices/register', { tag: 'Devices', summary: 'Register device token', requestBody: body() });
  add(paths, 'post', '/api/devices/unregister', { tag: 'Devices', summary: 'Unregister device token', requestBody: body() });
  add(paths, 'get', '/api/devices/my', { tag: 'Devices', summary: 'List my device tokens' });

  add(paths, 'get', '/api/notifications', { tag: 'Notifications', summary: 'List notifications' });
  add(paths, 'get', '/api/notifications/count', { tag: 'Notifications', summary: 'Get notifications count' });
  add(paths, 'post', '/api/notifications/mark-read', { tag: 'Notifications', summary: 'Mark notifications read', requestBody: body() });
  add(paths, 'post', '/api/notifications/mark-all-read', { tag: 'Notifications', summary: 'Mark all notifications read' });
  add(paths, 'post', '/api/notifications', { tag: 'Notifications', summary: 'Create notification', requestBody: body() });
  add(paths, 'get', '/api/notifications/{id}', { tag: 'Notifications', summary: 'Get notification', params: [pathParam('id')] });
  add(paths, 'delete', '/api/notifications/{id}', { tag: 'Notifications', summary: 'Delete notification', params: [pathParam('id')] });

  add(paths, 'get', '/api/reviews', { tag: 'Reviews', auth: false, summary: 'List reviews' });
  add(paths, 'post', '/api/reviews', { tag: 'Reviews', summary: 'Create review', requestBody: body() });
  add(paths, 'get', '/api/reviews/{id}', { tag: 'Reviews', auth: false, summary: 'Get review', params: [pathParam('id')] });

  add(paths, 'post', '/api/support', { tag: 'Support', summary: 'Create support thread', requestBody: body() });
  add(paths, 'post', '/api/support/{threadId}/messages', { tag: 'Support', summary: 'Post support message', params: [pathParam('threadId')], requestBody: body() });
  add(paths, 'get', '/api/support/{threadId}', { tag: 'Support', summary: 'Get support thread', params: [pathParam('threadId')] });
  add(paths, 'get', '/api/support/mine', { tag: 'Support', summary: 'List my support threads' });
  add(paths, 'get', '/api/support', { tag: 'Support', summary: 'Admin list all support threads' });

  add(paths, 'get', '/api/users/me', { tag: 'Users', summary: 'Get my profile' });
  add(paths, 'get', '/api/users/profile', { tag: 'Users', summary: 'Get my profile alias' });
  add(paths, 'delete', '/api/users/me', { tag: 'Users', summary: 'Delete my account' });
  add(paths, 'put', '/api/users/me', { tag: 'Users', summary: 'Update my profile', requestBody: body() });
  add(paths, 'get', '/api/users', { tag: 'Users', auth: false, summary: 'List users' });
  add(paths, 'post', '/api/users', { tag: 'Users', auth: false, summary: 'Create user', requestBody: body() });
  add(paths, 'delete', '/api/users/profile-image', { tag: 'Users', summary: 'Delete my profile image' });
  add(paths, 'get', '/api/users/{id}/full', { tag: 'Users', summary: 'Get full customer profile', params: [pathParam('id')] });
  add(paths, 'get', '/api/users/{id}', { tag: 'Users', auth: false, summary: 'Get user by id', params: [pathParam('id')] });
  add(paths, 'delete', '/api/users/{id}', { tag: 'Users', summary: 'Admin delete user', params: [pathParam('id')] });
}

function addSpecialAndAdminRoutes(paths) {
  add(paths, 'post', '/api/special-service-requests', { tag: 'Special Service Requests', summary: 'Create special service request', requestBody: body() });
  add(paths, 'get', '/api/special-service-requests', { tag: 'Special Service Requests', summary: 'List special service requests' });
  add(paths, 'get', '/api/special-service-requests/{id}', { tag: 'Special Service Requests', summary: 'Get special service request', params: [pathParam('id')] });
  add(paths, 'get', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Get special service request response', params: [pathParam('id')] });
  add(paths, 'put', '/api/special-service-requests/{id}', { tag: 'Special Service Requests', summary: 'Update special service request', params: [pathParam('id')], requestBody: body() });
  add(paths, 'put', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Respond to request as verified artisan', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Create/update artisan response', params: [pathParam('id')], requestBody: body() });
  add(paths, 'post', '/api/special-service-requests/{id}/pay', { tag: 'Special Service Requests', summary: 'Pay for special service request', params: [pathParam('id')], requestBody: body() });

  add(paths, 'get', '/api/transactions', { tag: 'Transactions', summary: 'List transactions' });
  add(paths, 'get', '/api/transactions/admin/summary', { tag: 'Transactions', summary: 'Admin transaction summary' });
  add(paths, 'get', '/api/transactions/{id}', { tag: 'Transactions', summary: 'Get transaction', params: [pathParam('id')] });

  const adminGet = [
    ['overview', 'Get admin dashboard overview'],
    ['central', 'Get central feed'],
    ['users', 'List users'],
    ['artisans', 'List artisans'],
    ['admins', 'List admins'],
    ['jobs', 'List jobs'],
    ['bookings', 'List bookings'],
    ['special-requests', 'List special requests'],
    ['quotes', 'List quotes'],
    ['chats', 'List chats'],
    ['wallets', 'List wallets'],
    ['company-earnings', 'List company earnings'],
    ['company-earnings/summary', 'Company earnings summary'],
    ['configs', 'List configs'],
  ];
  for (const [route, summary] of adminGet) add(paths, 'get', `/api/admin/${route}`, { tag: 'Admin', summary });
  add(paths, 'put', '/api/admin/artisans/{userId}', { tag: 'Admin', summary: 'Admin upsert artisan profile', params: [pathParam('userId')], requestBody: body() });
  add(paths, 'delete', '/api/admin/artisans/{userId}/profile-image', { tag: 'Admin', summary: 'Admin delete artisan profile image', params: [pathParam('userId')] });
  add(paths, 'put', '/api/admin/kyc/{userId}', { tag: 'Admin', summary: 'Admin upsert KYC', params: [pathParam('userId')], requestBody: body() });
  add(paths, 'get', '/api/admin/kyc/{userId}', { tag: 'Admin', summary: 'Admin get KYC by user', params: [pathParam('userId')] });
  add(paths, 'delete', '/api/admin/kyc/{userId}/file', { tag: 'Admin', summary: 'Admin delete KYC file', params: [pathParam('userId')] });
  add(paths, 'put', '/api/admin/users/{id}/ban', { tag: 'Admin', summary: 'Ban user', params: [pathParam('id')] });
  add(paths, 'put', '/api/admin/users/{id}/unban', { tag: 'Admin', summary: 'Unban user', params: [pathParam('id')] });
  add(paths, 'put', '/api/admin/users/{id}/role', { tag: 'Admin', summary: 'Update user role', params: [pathParam('id')], requestBody: body() });
  add(paths, 'get', '/api/admin/chats/{id}', { tag: 'Admin', summary: 'Admin get chat', params: [pathParam('id')] });
  add(paths, 'get', '/api/admin/wallets/{userId}', { tag: 'Admin', summary: 'Admin get wallet by user', params: [pathParam('userId')] });
  add(paths, 'post', '/api/admin/create', { tag: 'Admin', summary: 'Create admin account', requestBody: body() });
  add(paths, 'get', '/api/admin/configs/{key}', { tag: 'Admin', summary: 'Get config by key', params: [pathParam('key')] });
  add(paths, 'put', '/api/admin/configs/{key}', { tag: 'Admin', summary: 'Upsert config by key', params: [pathParam('key')], requestBody: body() });

  add(paths, 'get', '/docs', { tag: 'Documentation', auth: false, summary: 'Markdown API docs' });
  add(paths, 'get', '/documentation', { tag: 'Documentation', auth: false, summary: 'Documentation landing page' });
  add(paths, 'get', '/documentation/json', { tag: 'Documentation', auth: false, summary: 'OpenAPI JSON' });
  add(paths, 'get', '/documentation/routes', { tag: 'Documentation', auth: false, summary: 'Fastify route tree' });
}

function buildPaths() {
  const paths = {};
  addAuthRoutes(paths);
  addKycRoutes(paths);
  addApplicationRoutes(paths);
  addBookingAndPaymentRoutes(paths);
  addCommsAndUserRoutes(paths);
  addSpecialAndAdminRoutes(paths);
  return paths;
}

function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Artisan API',
      version: '1.0.0',
      description: 'Backend API for authentication, artisan onboarding, KYC, jobs, bookings, payments, notifications, support, ads, and admin operations.',
    },
    servers: [
      { url: process.env.API_BASE_URL || 'http://localhost:5000', description: 'Configured API base URL' },
    ],
    tags: [
      'Auth', 'KYC', 'Artisans', 'Artisan Services', 'Chat', 'Locations', 'Job Categories',
      'Job Subcategories', 'Jobs', 'Bookings', 'Special Service Requests', 'Payments',
      'Wallet', 'Devices', 'Notifications', 'Reviews', 'Support', 'Users', 'Transactions',
      'Ads', 'Admin', 'Documentation',
    ].map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        DojahNinSelfieJsonRequest: {
          type: 'object',
          required: ['nin', 'selfieImage'],
          properties: {
            nin: { type: 'string', pattern: '^\\d{11}$', example: '70123456789', description: '11-digit Nigerian NIN.' },
            selfieImage: { type: 'string', format: 'byte', description: 'Base64 selfie image. Data URL prefix is accepted and stripped.' },
            firstName: { type: 'string', example: 'John' },
            lastName: { type: 'string', example: 'Doe' },
          },
          additionalProperties: true,
        },
        DojahNinSelfieMultipartRequest: {
          type: 'object',
          required: ['nin', 'selfie'],
          properties: {
            nin: { type: 'string', pattern: '^\\d{11}$', example: '70123456789' },
            selfie: { type: 'string', format: 'binary', description: 'Selfie image file. Field may also be named selfieImage or selfie_image.' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
          },
        },
        DojahNinSelfieResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'NIN selfie verification approved' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['approved', 'rejected', 'pending_review'] },
                match: { type: 'boolean' },
                confidenceValue: { type: 'number' },
                threshold: { type: 'number' },
                user: { type: 'object', additionalProperties: true },
                artisan: { type: 'object', additionalProperties: true },
              },
              additionalProperties: true,
            },
          },
        },
      },
    },
    paths: buildPaths(),
  };
}

export default async function swaggerPlugin(fastify, opts) {
  const sendDocumentationHtml = async (_request, reply) => {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Artisan API Documentation</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; line-height: 1.5; color: #111; }
      code, pre { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
      a { color: #8a001f; }
    </style>
  </head>
  <body>
    <h1>Artisan API Documentation</h1>
    <p>OpenAPI JSON is available at <a href="/api/documentation/json">/api/documentation/json</a>.</p>
    <p>Registered Fastify routes are available at <a href="/api/documentation/routes">/api/documentation/routes</a>.</p>
    <p>Import the JSON URL into Swagger Editor, Postman, Insomnia, or Stoplight to browse all endpoints.</p>
  </body>
</html>`;
    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  };

  const sendRouteTree = async () => ({
    success: true,
    routes: fastify.printRoutes ? fastify.printRoutes() : 'routes info not available',
  });

  fastify.get('/documentation/json', async () => buildOpenApiSpec());
  fastify.get('/api/documentation/json', async () => buildOpenApiSpec());

  fastify.get('/documentation/routes', sendRouteTree);
  fastify.get('/api/documentation/routes', sendRouteTree);

  fastify.get('/documentation', sendDocumentationHtml);
  fastify.get('/api/documentation', sendDocumentationHtml);
}

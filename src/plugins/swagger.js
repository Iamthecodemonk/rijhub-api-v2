function jsonSchema(properties = {}, required = [], additionalProperties = false) {
  return { type: 'object', required, properties, additionalProperties };
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
            data: { type: 'object', additionalProperties: false },
          },
          additionalProperties: false,
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
            data: { type: 'object', additionalProperties: false },
          },
          additionalProperties: false,
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

function queryParam(name, schema, description = null, required = false) {
  const param = { name, in: 'query', required, schema };
  if (description) param.description = description;
  return param;
}

function body(content) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: content || { $ref: '#/components/schemas/FlexibleJsonRequest' },
      },
    },
  };
}

function refBody(schemaName, mediaType = 'application/json') {
  return {
    required: true,
    content: {
      [mediaType]: {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

function jsonAndMultipartBody(schemaName, multipartSchemaName = schemaName) {
  return {
    required: true,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
      'multipart/form-data': { schema: { $ref: `#/components/schemas/${multipartSchemaName}` } },
    },
  };
}

function multipartBody(schemaName) {
  return refBody(schemaName, 'multipart/form-data');
}

function genericOperation({ tag, summary, description = null, auth = true, params = [], requestBody = null, responses = null, operationId = null }) {
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
  if (description) op.description = description;
  if (operationId) op.operationId = operationId;
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
  const schemaBySingular = {
    ad: 'AdRequest',
    'announcement ad': 'AdRequest',
    'job category': 'JobCategoryRequest',
    'job subcategory': 'JobSubcategoryRequest',
  };
  const requestBody = schemaBySingular[singular] ? refBody(schemaBySingular[singular]) : body();
  add(paths, 'get', base, { tag, summary: `List ${tag.toLowerCase()}`, auth: false });
  add(paths, 'post', base, { tag, summary: `Create ${singular}`, requestBody });
  add(paths, 'get', `${base}/{id}`, { tag, summary: `Get ${singular}`, auth: false, params: [pathParam('id')] });
  add(paths, 'put', `${base}/{id}`, { tag, summary: `Update ${singular}`, params: [pathParam('id')], requestBody });
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
  add(paths, 'post', '/api/auth/guest', { tag, auth: false, summary: 'Create or login as guest user', requestBody: refBody('GuestLoginRequest') });
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
  add(paths, 'post', '/api/auth/registeruserfirebase', { tag, auth: false, summary: 'Register user using Firebase phone verification', requestBody: refBody('FirebaseRegisterRequest') });
  add(paths, 'post', '/api/auth/verify-remote', { tag, auth: false, summary: 'Verify remote token', requestBody: body(jsonSchema({ token: { type: 'string' } })) });
  add(paths, 'get', '/api/auth/verify', { tag, summary: 'Verify JWT and return decoded payload' });
}

function addKycRoutes(paths) {
  const tag = 'KYC';
  add(paths, 'get', '/api/kyc/dojah/config', {
    tag,
    summary: 'Get Dojah SDK widget config',
    description: 'Returns the public Dojah EasyOnboard widget id for the mobile SDK. Does not expose AppId, secret key, or webhook secret.',
    responses: {
      200: { description: 'Dojah SDK config', content: { 'application/json': { schema: { $ref: '#/components/schemas/DojahSdkConfigResponse' } } } },
      401: errorResponse('Missing or invalid JWT'),
      500: errorResponse('Dojah widget config missing'),
    },
  });
  add(paths, 'post', '/api/kyc/dojah/start-session', {
    tag,
    summary: 'Start Dojah SDK verification session',
    description: 'Creates a local KYC session and referenceId that the mobile app can pass into the Dojah Flutter SDK.',
    responses: {
      200: { description: 'Dojah SDK session started', content: { 'application/json': { schema: { $ref: '#/components/schemas/DojahStartSessionResponse' } } } },
      401: errorResponse('Missing or invalid JWT'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'post', '/api/kyc/dojah/verify-reference', {
    tag,
    summary: 'Verify Dojah SDK reference',
    description: 'Fetches final verification details from Dojah using the SDK reference id, validates ownership, syncs KYC/User/Artisan verification state, and returns approved, rejected, or pending status.',
    requestBody: refBody('DojahVerifyReferenceRequest'),
    responses: {
      200: { description: 'Verification reference processed', content: { 'application/json': { schema: { $ref: '#/components/schemas/DojahVerifyReferenceResponse' } } } },
      400: errorResponse('Missing or invalid referenceId'),
      401: errorResponse('Missing or invalid JWT'),
      403: errorResponse('referenceId belongs to a different user'),
      404: errorResponse('referenceId not found at Dojah'),
      502: errorResponse('Dojah verification details request failed'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'post', '/api/kyc/dojah/webhook', {
    tag,
    auth: false,
    summary: 'Receive Dojah SDK webhook',
    description: 'Optional Dojah webhook for asynchronous EasyOnboard verification completion. If DOJAH_WEBHOOK_SECRET is set, X-Dojah-Signature is validated with HMAC SHA-256.',
    requestBody: refBody('DojahWebhookRequest'),
    responses: {
      200: successResponse('Webhook processed'),
      400: errorResponse('Missing referenceId'),
      401: errorResponse('Invalid webhook signature'),
      404: errorResponse('KYC session not found for referenceId'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'post', '/api/kyc/dojah/nin-selfie', {
    tag,
    operationId: 'verifyDojahNinSelfie',
    summary: 'Verify Nigerian NIN with selfie through Dojah',
    description: [
      'Verifies the authenticated user with an 11-digit Nigerian NIN and a selfie image.',
      'The selfie can be sent as base64 JSON or as multipart/form-data.',
      'Accepted selfie field names are selfieImage, selfie_image, and selfie.',
      'A successful match sets KYC to approved, marks the user as verified, and verifies the artisan profile when one exists.',
      'If Dojah rejects the request or the verification call fails, the KYC record is marked rejected with providerStatus failed and failureReason for the client UI.',
      'Approval requires Dojah selfie match plus confidence greater than or equal to DOJAH_NIN_SELFIE_CONFIDENCE_THRESHOLD, default 90.',
    ].join('\n\n'),
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/DojahNinSelfieJsonRequest' },
          examples: {
            base64Selfie: {
              summary: 'Base64 selfie',
              value: {
                nin: '70123456789',
                selfieImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...',
                firstName: 'John',
                lastName: 'Doe',
              },
            },
          },
        },
        'multipart/form-data': {
          schema: { $ref: '#/components/schemas/DojahNinSelfieMultipartRequest' },
        },
      },
    },
    responses: {
      200: {
        description: 'Verification completed. Status may be approved or rejected depending on Dojah selfie match and confidence threshold.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/DojahNinSelfieResponse' },
            examples: {
              approved: {
                value: {
                  success: true,
                  message: 'NIN selfie verification approved',
                  data: {
                    status: 'approved',
                    match: true,
                    confidenceValue: 98.4,
                    threshold: 90,
                    user: { _id: '6624b1b15e0c8c2c64a00001', kycVerified: true, isVerified: true, kycLevel: 2 },
                    artisan: { _id: '6624b1b15e0c8c2c64a00002', verified: true },
                  },
                },
              },
              rejected: {
                value: {
                  success: true,
                  message: 'NIN selfie verification rejected',
                  data: {
                    status: 'rejected',
                    match: false,
                    confidenceValue: 41.2,
                    threshold: 90,
                    user: { _id: '6624b1b15e0c8c2c64a00001', kycVerified: false, isVerified: false, kycLevel: 1 },
                    artisan: { _id: '6624b1b15e0c8c2c64a00002', verified: false },
                  },
                },
              },
            },
          },
        },
      },
      202: {
        description: 'Verification request failed before approval could be completed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/DojahNinSelfieManualReviewResponse' } } },
      },
      400: errorResponse('Invalid NIN or missing selfie'),
      401: errorResponse('Missing or invalid JWT'),
      500: errorResponse('Dojah configuration or server error'),
    },
  });
  add(paths, 'post', '/api/kyc/submit', {
    tag,
    summary: 'Submit manual KYC fallback',
    description: 'Submits KYC details and optional document/selfie files for manual admin review.',
    requestBody: multipartBody('ManualKycMultipartRequest'),
  });
  add(paths, 'get', '/api/kyc/status', {
    tag,
    summary: 'Get current user KYC status',
    responses: {
      200: { description: 'Current KYC status', content: { 'application/json': { schema: { $ref: '#/components/schemas/KycStatusResponse' } } } },
      401: errorResponse('Unauthorized'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'get', '/api/kyc/artisan/{id}/status', {
    tag,
    auth: false,
    params: [pathParam('id')],
    summary: 'Get an artisan KYC status',
    description: 'Returns the latest KYC status for an artisan. The id can be the artisan profile id or the linked user id.',
    responses: {
      200: { description: 'Artisan KYC status', content: { 'application/json': { schema: { $ref: '#/components/schemas/ArtisanKycStatusResponse' } } } },
      400: errorResponse('Invalid artisan id'),
      404: errorResponse('Artisan not found'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'delete', '/api/kyc/{id}/file', { tag, summary: 'Delete uploaded KYC file', params: [pathParam('id')] });
}

function addApplicationRoutes(paths) {
  addCrud(paths, '/api/ads', 'Ads', 'ad');
  addCrud(paths, '/api/announcements/ads', 'Ads', 'announcement ad');
  for (const base of ['/api/ads', '/api/announcements/ads']) {
    add(paths, 'get', `${base}/marquee`, { tag: 'Ads', auth: false, summary: 'Get marquee ad' });
    add(paths, 'post', `${base}/marquee`, { tag: 'Ads', summary: 'Create or update marquee ad', requestBody: refBody('AdMarqueeRequest') });
    add(paths, 'get', `${base}/banner`, { tag: 'Ads', auth: false, summary: 'List banner ads' });
    add(paths, 'post', `${base}/banner`, { tag: 'Ads', summary: 'Create banner ad', requestBody: refBody('AdRequest') });
    add(paths, 'get', `${base}/carousel`, { tag: 'Ads', auth: false, summary: 'List carousel ads' });
    add(paths, 'post', `${base}/carousel`, { tag: 'Ads', summary: 'Create carousel ad', requestBody: refBody('AdRequest') });
  }

  add(paths, 'get', '/api/artisans', { tag: 'Artisans', auth: false, summary: 'List/discover artisans' });
  add(paths, 'get', '/api/artisans/search', { tag: 'Artisans', auth: false, summary: 'Search artisans' });
  add(paths, 'get', '/api/artisans/user/{id}', { tag: 'Artisans', auth: false, summary: 'Get artisan profile by user id', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisans/me', { tag: 'Artisans', summary: 'Update authenticated artisan profile', requestBody: jsonAndMultipartBody('ArtisanProfileRequest', 'ArtisanProfileMultipartRequest') });
  add(paths, 'post', '/api/artisans', { tag: 'Artisans', summary: 'Create artisan profile', requestBody: jsonAndMultipartBody('ArtisanProfileRequest', 'ArtisanProfileMultipartRequest') });
  add(paths, 'get', '/api/artisans/{id}', { tag: 'Artisans', auth: false, summary: 'Get artisan profile', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisans/{id}', { tag: 'Artisans', summary: 'Update artisan profile', params: [pathParam('id')], requestBody: jsonAndMultipartBody('ArtisanProfileRequest', 'ArtisanProfileMultipartRequest') });
  add(paths, 'patch', '/api/artisans/{id}/verify', { tag: 'Artisans', summary: 'Admin verify artisan', params: [pathParam('id')] });
  add(paths, 'patch', '/api/artisans/{id}/unverify', { tag: 'Artisans', summary: 'Admin unverify artisan', params: [pathParam('id')] });

  add(paths, 'get', '/api/artisan-services/artisan/{artisanId}', { tag: 'Artisan Services', auth: false, summary: 'List services for artisan', params: [pathParam('artisanId')] });
  add(paths, 'post', '/api/artisan-services', { tag: 'Artisan Services', summary: 'Create or update artisan services/prices', requestBody: refBody('ArtisanServiceRequest') });
  add(paths, 'get', '/api/artisan-services/me', { tag: 'Artisan Services', summary: 'List my artisan services' });
  add(paths, 'get', '/api/artisan-services/price-suggestion', {
    tag: 'Artisan Services',
    auth: false,
    summary: 'Get price suggestion for category and optional subcategory',
    description: 'Returns market pricing guidance for new artisan onboarding. Provide categoryId for main-category guidance, or subCategoryId for exact subservice guidance. When both are provided, the subcategory must belong to the category and the response includes both category and subcategory suggestions.',
    params: [
      queryParam('categoryId', { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, 'Main service/category id.'),
      queryParam('subCategoryId', { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, 'Subservice/subcategory id.'),
    ],
    responses: {
      200: { description: 'Price suggestion fetched', content: { 'application/json': { schema: { $ref: '#/components/schemas/PriceSuggestionResponse' } } } },
      400: errorResponse('categoryId or subCategoryId is required, or subcategory does not belong to category'),
      404: errorResponse('Category or subcategory not found'),
      500: errorResponse('Server error'),
    },
  });
  add(paths, 'get', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Get artisan service', params: [pathParam('id')] });
  add(paths, 'put', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Update artisan service', params: [pathParam('id')], requestBody: refBody('ArtisanServiceRequest') });
  add(paths, 'delete', '/api/artisan-services/{id}', { tag: 'Artisan Services', summary: 'Delete artisan service', params: [pathParam('id')] });

  add(paths, 'get', '/api/chat/booking/{bookingId}', { tag: 'Chat', summary: 'Fetch chat thread by booking', params: [pathParam('bookingId')] });
  add(paths, 'get', '/api/chat/{threadId}', { tag: 'Chat', summary: 'Fetch chat thread', params: [pathParam('threadId')] });
  add(paths, 'post', '/api/chat/{threadId}', { tag: 'Chat', summary: 'Send chat message', params: [pathParam('threadId')], requestBody: refBody('ChatMessageRequest') });

  add(paths, 'get', '/api/locations/nigeria/states', { tag: 'Locations', auth: false, summary: 'List Nigerian states' });
  add(paths, 'get', '/api/locations/nigeria/lgas', { tag: 'Locations', auth: false, summary: 'List LGAs for a Nigerian state' });

  addCrud(paths, '/api/job-categories', 'Job Categories', 'job category');
  addCrud(paths, '/api/job-subcategories', 'Job Subcategories', 'job subcategory');

  add(paths, 'get', '/api/jobs/mine', { tag: 'Jobs', summary: 'List authenticated customer jobs' });
  add(paths, 'get', '/api/jobs', { tag: 'Jobs', summary: 'List jobs' });
  add(paths, 'post', '/api/jobs', { tag: 'Jobs', summary: 'Create job', requestBody: refBody('JobCreateRequest') });
  add(paths, 'get', '/api/jobs/{id}', { tag: 'Jobs', auth: false, summary: 'Get job', params: [pathParam('id')] });
  add(paths, 'put', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Update job', params: [pathParam('id')], requestBody: refBody('JobUpdateRequest') });
  add(paths, 'patch', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Patch job', params: [pathParam('id')], requestBody: refBody('JobUpdateRequest') });
  add(paths, 'delete', '/api/jobs/{id}', { tag: 'Jobs', summary: 'Close/delete job', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/apply', { tag: 'Jobs', summary: 'Apply to job as verified artisan', params: [pathParam('id')], requestBody: refBody('JobApplicationRequest') });
  add(paths, 'get', '/api/jobs/{id}/applications', { tag: 'Jobs', summary: 'List job applications', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/applications/{appId}/accept', { tag: 'Jobs', summary: 'Accept job application', params: [pathParam('id'), pathParam('appId')], requestBody: refBody('PaymentModeRequest') });
  add(paths, 'patch', '/api/jobs/{id}/applications/{appId}', { tag: 'Jobs', summary: 'Update job application', params: [pathParam('id'), pathParam('appId')], requestBody: refBody('JobApplicationUpdateRequest') });
  add(paths, 'post', '/api/jobs/{id}/applications/{appId}/withdraw', { tag: 'Jobs', summary: 'Withdraw job application', params: [pathParam('id'), pathParam('appId')] });
  add(paths, 'post', '/api/jobs/{id}/attachments', {
    tag: 'Jobs',
    summary: 'Upload job attachment',
    params: [pathParam('id')],
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: jsonSchema({ file: { type: 'string', format: 'binary' }, attachment: { type: 'string', format: 'binary' } }),
        },
      },
    },
  });
  add(paths, 'delete', '/api/jobs/{id}/attachments', { tag: 'Jobs', summary: 'Delete job attachment', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/quotes', { tag: 'Jobs', summary: 'Create job quote', params: [pathParam('id')], requestBody: refBody('QuoteCreateRequest') });
  add(paths, 'get', '/api/jobs/{id}/quotes', { tag: 'Jobs', summary: 'List job quotes', params: [pathParam('id')] });
  add(paths, 'post', '/api/jobs/{id}/quotes/{quoteId}/accept', { tag: 'Jobs', summary: 'Accept job quote', params: [pathParam('id'), pathParam('quoteId')], requestBody: refBody('PaymentModeRequest') });
}

function addBookingAndPaymentRoutes(paths) {
  add(paths, 'get', '/api/bookings', { tag: 'Bookings', summary: 'List bookings' });
  add(paths, 'post', '/api/bookings', { tag: 'Bookings', summary: 'Create booking', requestBody: refBody('BookingCreateRequest') });
  add(paths, 'get', '/api/bookings/customer/{customerId}', { tag: 'Bookings', summary: 'List customer bookings', params: [pathParam('customerId')] });
  add(paths, 'get', '/api/bookings/artisan/{artisanId}', { tag: 'Bookings', summary: 'List artisan bookings', params: [pathParam('artisanId')] });
  add(paths, 'get', '/api/bookings/{id}', { tag: 'Bookings', summary: 'Get booking', params: [pathParam('id')] });
  add(paths, 'delete', '/api/bookings/{id}', { tag: 'Bookings', summary: 'Cancel booking', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/artisan-cancel', { tag: 'Bookings', summary: 'Cancel booking as verified artisan', params: [pathParam('id')], requestBody: refBody('CancelReasonRequest') });
  add(paths, 'get', '/api/bookings/{id}/refund', { tag: 'Bookings', summary: 'Get booking refund status', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/hire', { tag: 'Bookings', summary: 'Hire artisan and initialize payment when needed', requestBody: refBody('BookingHireRequest') });
  add(paths, 'post', '/api/bookings/{id}/pay-after-completion', {
    tag: 'Bookings',
    summary: 'Pay deferred booking after completion',
    params: [pathParam('id')],
    requestBody: body(jsonSchema({
      email: { type: 'string', format: 'email' },
      customerCoords: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
    })),
  });
  add(paths, 'post', '/api/bookings/{id}/complete', { tag: 'Bookings', summary: 'Complete booking', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/accept', { tag: 'Bookings', summary: 'Accept booking as verified artisan', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/reject', { tag: 'Bookings', summary: 'Reject booking as verified artisan', params: [pathParam('id')], requestBody: body(jsonSchema({ reason: { type: 'string' } })) });
  add(paths, 'post', '/api/bookings/{id}/requirements', { tag: 'Bookings', summary: 'Post booking requirement', params: [pathParam('id')], requestBody: refBody('BookingRequirementRequest') });
  add(paths, 'post', '/api/bookings/{id}/quotes', { tag: 'Bookings', summary: 'Create booking quote as verified artisan', params: [pathParam('id')], requestBody: refBody('QuoteCreateRequest') });
  add(paths, 'get', '/api/bookings/{id}/quotes', { tag: 'Bookings', summary: 'List booking quotes', params: [pathParam('id')] });
  add(paths, 'get', '/api/bookings/{id}/quotes/details', { tag: 'Bookings', summary: 'List detailed booking quotes', params: [pathParam('id')] });
  add(paths, 'post', '/api/bookings/{id}/quotes/{quoteId}/accept', { tag: 'Bookings', summary: 'Accept booking quote', params: [pathParam('id'), pathParam('quoteId')], requestBody: refBody('PaymentModeRequest') });
  add(paths, 'post', '/api/bookings/{id}/pay-with-quote', { tag: 'Bookings', summary: 'Pay booking with accepted quote', params: [pathParam('id')], requestBody: refBody('EmailRequest') });
  add(paths, 'post', '/api/bookings/{id}/confirm-payment', { tag: 'Bookings', summary: 'Confirm booking payment', params: [pathParam('id')] });

  add(paths, 'post', '/api/payments', { tag: 'Payments', summary: 'Create payment record', requestBody: refBody('PaymentCreateRequest') });
  add(paths, 'post', '/api/payments/verify', { tag: 'Payments', summary: 'Verify payment', requestBody: refBody('PaymentVerifyRequest') });
  add(paths, 'post', '/api/payments/webhook', { tag: 'Payments', auth: false, summary: 'Paystack webhook endpoint', requestBody: refBody('PaystackWebhookRequest') });
  add(paths, 'post', '/api/payments/reconcile/pending-quotes', { tag: 'Payments', summary: 'Admin reconcile pending quote transactions' });
  add(paths, 'post', '/api/payments/initialize', { tag: 'Payments', summary: 'Initialize Paystack transaction', requestBody: refBody('PaymentInitializeRequest') });
  add(paths, 'get', '/api/payments/callback', { tag: 'Payments', auth: false, summary: 'Paystack callback endpoint' });
  add(paths, 'get', '/api/payments', { tag: 'Payments', summary: 'List payments' });
  add(paths, 'get', '/api/payments/banks', { tag: 'Payments', summary: 'List Paystack banks' });
  add(paths, 'get', '/api/payments/banks/resolve', { tag: 'Payments', summary: 'Resolve Paystack account' });

  add(paths, 'get', '/api/wallet', { tag: 'Wallet', summary: 'Get wallet' });
  add(paths, 'post', '/api/wallet/credit', { tag: 'Wallet', summary: 'Credit wallet', requestBody: refBody('WalletAmountRequest') });
  add(paths, 'post', '/api/wallet/debit', { tag: 'Wallet', summary: 'Debit wallet', requestBody: refBody('WalletAmountRequest') });
  add(paths, 'post', '/api/wallet/payout-details', { tag: 'Wallet', summary: 'Set payout details', requestBody: refBody('PayoutDetailsRequest') });
  add(paths, 'get', '/api/wallet/payout-details', { tag: 'Wallet', summary: 'Get payout details' });
}

function addCommsAndUserRoutes(paths) {
  add(paths, 'post', '/api/devices/register', { tag: 'Devices', summary: 'Register device token', requestBody: refBody('DeviceTokenRequest') });
  add(paths, 'post', '/api/devices/unregister', { tag: 'Devices', summary: 'Unregister device token', requestBody: refBody('DeviceTokenRequest') });
  add(paths, 'get', '/api/devices/my', { tag: 'Devices', summary: 'List my device tokens' });

  add(paths, 'get', '/api/notifications', { tag: 'Notifications', summary: 'List notifications' });
  add(paths, 'get', '/api/notifications/count', { tag: 'Notifications', summary: 'Get notifications count' });
  add(paths, 'post', '/api/notifications/mark-read', { tag: 'Notifications', summary: 'Mark notifications read', requestBody: refBody('NotificationMarkReadRequest') });
  add(paths, 'post', '/api/notifications/mark-all-read', { tag: 'Notifications', summary: 'Mark all notifications read' });
  add(paths, 'post', '/api/notifications', { tag: 'Notifications', summary: 'Create notification', requestBody: refBody('NotificationCreateRequest') });
  add(paths, 'get', '/api/notifications/{id}', { tag: 'Notifications', summary: 'Get notification', params: [pathParam('id')] });
  add(paths, 'delete', '/api/notifications/{id}', { tag: 'Notifications', summary: 'Delete notification', params: [pathParam('id')] });

  add(paths, 'get', '/api/reviews', { tag: 'Reviews', auth: false, summary: 'List reviews' });
  add(paths, 'post', '/api/reviews', { tag: 'Reviews', summary: 'Create review', requestBody: refBody('ReviewCreateRequest') });
  add(paths, 'get', '/api/reviews/{id}', { tag: 'Reviews', auth: false, summary: 'Get review', params: [pathParam('id')] });

  add(paths, 'post', '/api/support', { tag: 'Support', summary: 'Create support thread', requestBody: refBody('SupportThreadRequest') });
  add(paths, 'post', '/api/support/{threadId}/messages', { tag: 'Support', summary: 'Post support message', params: [pathParam('threadId')], requestBody: refBody('SupportMessageRequest') });
  add(paths, 'get', '/api/support/{threadId}', { tag: 'Support', summary: 'Get support thread', params: [pathParam('threadId')] });
  add(paths, 'get', '/api/support/mine', { tag: 'Support', summary: 'List my support threads' });
  add(paths, 'get', '/api/support', { tag: 'Support', summary: 'Admin list all support threads' });

  add(paths, 'get', '/api/users/me', { tag: 'Users', summary: 'Get my profile' });
  add(paths, 'get', '/api/users/profile', { tag: 'Users', summary: 'Get my profile alias' });
  add(paths, 'delete', '/api/users/me', { tag: 'Users', summary: 'Delete my account' });
  add(paths, 'put', '/api/users/me', {
    tag: 'Users',
    summary: 'Update my profile',
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: jsonSchema({
            name: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            profileImage: { type: 'string', format: 'binary' },
          }),
        },
        'application/json': {
          schema: jsonSchema({ name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } }),
        },
      },
    },
  });
  add(paths, 'get', '/api/users', { tag: 'Users', auth: false, summary: 'List users' });
  add(paths, 'post', '/api/users', { tag: 'Users', auth: false, summary: 'Create user', requestBody: refBody('UserCreateRequest') });
  add(paths, 'delete', '/api/users/profile-image', { tag: 'Users', summary: 'Delete my profile image' });
  add(paths, 'get', '/api/users/{id}/full', { tag: 'Users', summary: 'Get full customer profile', params: [pathParam('id')] });
  add(paths, 'get', '/api/users/{id}', { tag: 'Users', auth: false, summary: 'Get user by id', params: [pathParam('id')] });
  add(paths, 'delete', '/api/users/{id}', { tag: 'Users', summary: 'Admin delete user', params: [pathParam('id')] });
}

function addSpecialAndAdminRoutes(paths) {
  add(paths, 'post', '/api/special-service-requests', {
    tag: 'Special Service Requests',
    summary: 'Create special service request',
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': { schema: { $ref: '#/components/schemas/SpecialServiceRequestMultipartRequest' } },
        'application/json': { schema: { $ref: '#/components/schemas/SpecialServiceRequestCreateRequest' } },
      },
    },
  });
  add(paths, 'get', '/api/special-service-requests', { tag: 'Special Service Requests', summary: 'List special service requests' });
  add(paths, 'get', '/api/special-service-requests/{id}', { tag: 'Special Service Requests', summary: 'Get special service request', params: [pathParam('id')] });
  add(paths, 'get', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Get special service request response', params: [pathParam('id')] });
  add(paths, 'put', '/api/special-service-requests/{id}', { tag: 'Special Service Requests', summary: 'Update special service request', params: [pathParam('id')], requestBody: refBody('SpecialServiceRequestUpdateRequest') });
  add(paths, 'put', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Respond to request as verified artisan', params: [pathParam('id')], requestBody: refBody('SpecialServiceResponseRequest') });
  add(paths, 'post', '/api/special-service-requests/{id}/response', { tag: 'Special Service Requests', summary: 'Create/update artisan response', params: [pathParam('id')], requestBody: refBody('SpecialServiceResponseRequest') });
  add(paths, 'post', '/api/special-service-requests/{id}/pay', { tag: 'Special Service Requests', summary: 'Pay for special service request', params: [pathParam('id')], requestBody: refBody('EmailRequest') });

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
  add(paths, 'put', '/api/admin/artisans/{userId}', {
    tag: 'Admin',
    summary: 'Admin upsert artisan profile',
    params: [pathParam('userId')],
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: jsonSchema({ name: { type: 'string' }, bio: { type: 'string' }, profileImage: { type: 'string', format: 'binary' } }),
        },
        'application/json': { schema: jsonSchema({ name: { type: 'string' }, bio: { type: 'string' }, verified: { type: 'boolean' } }) },
      },
    },
  });
  add(paths, 'delete', '/api/admin/artisans/{userId}/profile-image', { tag: 'Admin', summary: 'Admin delete artisan profile image', params: [pathParam('userId')] });
  add(paths, 'put', '/api/admin/kyc/{userId}', { tag: 'Admin', summary: 'Admin upsert KYC', params: [pathParam('userId')], requestBody: multipartBody('ManualKycMultipartRequest') });
  add(paths, 'get', '/api/admin/kyc/{userId}', { tag: 'Admin', summary: 'Admin get KYC by user', params: [pathParam('userId')] });
  add(paths, 'delete', '/api/admin/kyc/{userId}/file', { tag: 'Admin', summary: 'Admin delete KYC file', params: [pathParam('userId')] });
  add(paths, 'put', '/api/admin/users/{id}/ban', { tag: 'Admin', summary: 'Ban user', params: [pathParam('id')] });
  add(paths, 'put', '/api/admin/users/{id}/unban', { tag: 'Admin', summary: 'Unban user', params: [pathParam('id')] });
  add(paths, 'put', '/api/admin/users/{id}/role', { tag: 'Admin', summary: 'Update user role', params: [pathParam('id')], requestBody: body(jsonSchema({ role: { type: 'string', enum: ['admin', 'artisan', 'customer', 'client'] } }, ['role'])) });
  add(paths, 'get', '/api/admin/chats/{id}', { tag: 'Admin', summary: 'Admin get chat', params: [pathParam('id')] });
  add(paths, 'get', '/api/admin/wallets/{userId}', { tag: 'Admin', summary: 'Admin get wallet by user', params: [pathParam('userId')] });
  add(paths, 'post', '/api/admin/create', { tag: 'Admin', summary: 'Create admin account', requestBody: refBody('AdminCreateRequest') });
  add(paths, 'get', '/api/admin/configs/{key}', { tag: 'Admin', summary: 'Get config by key', params: [pathParam('key')] });
  add(paths, 'put', '/api/admin/configs/{key}', { tag: 'Admin', summary: 'Upsert config by key', params: [pathParam('key')], requestBody: refBody('ConfigUpsertRequest') });

  add(paths, 'get', '/docs', { tag: 'Documentation', auth: false, summary: 'Markdown API docs' });
  add(paths, 'get', '/documentation', { tag: 'Documentation', auth: false, summary: 'Documentation landing page' });
  add(paths, 'get', '/documentation/json', { tag: 'Documentation', auth: false, summary: 'OpenAPI JSON' });
  add(paths, 'get', '/documentation/routes', { tag: 'Documentation', auth: false, summary: 'Fastify route tree' });
  add(paths, 'get', '/api/documentation', { tag: 'Documentation', auth: false, summary: 'Swagger UI documentation' });
  add(paths, 'get', '/api/documentation/json', { tag: 'Documentation', auth: false, summary: 'OpenAPI JSON' });
  add(paths, 'get', '/api/documentation/routes', { tag: 'Documentation', auth: false, summary: 'Fastify route tree' });
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
        GenericSuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: false },
          },
          additionalProperties: false,
        },
        GenericErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            code: { type: 'string' },
            data: { type: 'object', additionalProperties: false },
          },
          additionalProperties: false,
        },
        FlexibleJsonRequest: {
          type: 'object',
          description: 'Endpoint accepts a flexible JSON object. Check the endpoint summary for the expected workflow-specific fields.',
          properties: {
            note: { type: 'string', example: 'Use workflow-specific fields for this endpoint.' },
          },
          additionalProperties: false,
          example: {
            note: 'Use workflow-specific fields for this endpoint.',
          },
        },
        GuestLoginRequest: {
          type: 'object',
          description: 'Optional client-generated guest metadata. Empty body is allowed.',
          properties: {
            deviceId: { type: 'string', example: 'device-abc-123' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'] },
          },
          additionalProperties: false,
        },
        FirebaseRegisterRequest: {
          type: 'object',
          properties: {
            firebaseToken: { type: 'string', description: 'Firebase ID token from phone authentication.' },
            idToken: { type: 'string', description: 'Alias for firebaseToken.' },
            phone: { type: 'string', example: '+2348012345678' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['customer', 'client', 'artisan'] },
          },
          additionalProperties: false,
        },
        AdRequest: {
          type: 'object',
          properties: {
            title: { type: 'string', example: 'Weekend artisan discount' },
            message: { type: 'string' },
            imageUrl: { type: 'string', format: 'uri' },
            linkUrl: { type: 'string', format: 'uri' },
            placement: { type: 'string', example: 'banner' },
            startDate: { type: 'string', format: 'date-time' },
            endDate: { type: 'string', format: 'date-time' },
            isActive: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        AdMarqueeRequest: {
          type: 'object',
          properties: {
            text: { type: 'string', example: 'Book verified artisans near you today' },
            linkUrl: { type: 'string', format: 'uri' },
            isActive: { type: 'boolean', example: true },
          },
          additionalProperties: false,
        },
        JobCategoryRequest: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', example: 'Plumbing' },
            description: { type: 'string' },
            icon: { type: 'string' },
            imageUrl: { type: 'string', format: 'uri' },
            isActive: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        JobSubcategoryRequest: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', example: 'Pipe repair' },
            categoryId: { type: 'string', example: '6624b1b15e0c8c2c64a00001' },
            description: { type: 'string' },
            icon: { type: 'string' },
            isActive: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        DojahNinSelfieJsonRequest: {
          type: 'object',
          required: ['nin', 'selfieImage'],
          properties: {
            nin: { type: 'string', pattern: '^\\d{11}$', example: '70123456789', description: '11-digit Nigerian NIN.' },
            idNumber: { type: 'string', pattern: '^\\d{11}$', example: '70123456789', description: 'Alias for nin.' },
            selfieImage: { type: 'string', format: 'byte', description: 'Base64 selfie image. A data URL prefix such as data:image/jpeg;base64, is accepted and stripped.' },
            selfie_image: { type: 'string', format: 'byte', description: 'Alias for selfieImage.' },
            selfie: { type: 'string', format: 'byte', description: 'Alias for selfieImage.' },
            firstName: { type: 'string', example: 'John' },
            first_name: { type: 'string', example: 'John', description: 'Alias for firstName.' },
            lastName: { type: 'string', example: 'Doe' },
            last_name: { type: 'string', example: 'Doe', description: 'Alias for lastName.' },
          },
          additionalProperties: false,
        },
        DojahSdkConfigResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                widgetId: { type: 'string', example: 'wgt_xxxxxxxxxxxx' },
                environment: { type: 'string', enum: ['sandbox', 'production'], example: 'sandbox' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        DojahStartSessionResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                referenceId: { type: 'string', example: 'rij_kyc_lx9p2kw_6624b1b15e0c8c2c64a00001' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        DojahVerifyReferenceRequest: {
          type: 'object',
          required: ['referenceId'],
          properties: {
            referenceId: { type: 'string', example: 'rij_kyc_lx9p2kw_6624b1b15e0c8c2c64a00001' },
            reference_id: { type: 'string', description: 'Alias for referenceId.' },
          },
          additionalProperties: false,
        },
        DojahVerifyReferenceResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'KYC verification approved' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['approved', 'rejected', 'pending'] },
                match: { type: 'boolean' },
                confidenceValue: { type: 'number' },
                threshold: { type: 'number', example: 90 },
                provider: { type: 'string', example: 'dojah' },
                verificationType: { type: 'string', example: 'sdk_widget' },
                referenceId: { type: 'string' },
                failureReason: { type: 'string', nullable: true },
                user: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    kycVerified: { type: 'boolean' },
                    isVerified: { type: 'boolean' },
                    kycLevel: { type: 'number' },
                  },
                  additionalProperties: false,
                },
                artisan: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    verified: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        DojahWebhookRequest: {
          type: 'object',
          properties: {
            reference_id: { type: 'string' },
            referenceId: { type: 'string' },
            verification_status: { type: 'string', enum: ['Completed', 'Ongoing', 'Pending', 'Failed', 'Abandoned'] },
            status: { type: 'boolean' },
            data: { type: 'object', additionalProperties: false },
            metadata: { type: 'object', additionalProperties: false },
          },
          additionalProperties: false,
        },
        DojahNinSelfieMultipartRequest: {
          type: 'object',
          required: ['nin'],
          properties: {
            nin: { type: 'string', pattern: '^\\d{11}$', example: '70123456789' },
            idNumber: { type: 'string', pattern: '^\\d{11}$', example: '70123456789', description: 'Alias for nin.' },
            selfie: { type: 'string', format: 'binary', description: 'Selfie image file.' },
            selfieImage: { type: 'string', format: 'binary', description: 'Alias file field for selfie.' },
            selfie_image: { type: 'string', format: 'binary', description: 'Alias file field for selfie.' },
            firstName: { type: 'string' },
            first_name: { type: 'string' },
            lastName: { type: 'string' },
            last_name: { type: 'string' },
          },
          description: 'Provide one selfie file field named selfie, selfieImage, or selfie_image.',
        },
        DojahNinSelfieResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'NIN selfie verification approved' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['approved', 'rejected'] },
                providerStatus: { type: 'string', enum: ['verified', 'not_verified', 'failed'], nullable: true },
                match: { type: 'boolean' },
                confidenceValue: { type: 'number' },
                threshold: { type: 'number' },
                failureReason: { type: 'string', nullable: true },
                user: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    kycVerified: { type: 'boolean' },
                    isVerified: { type: 'boolean' },
                    kycLevel: { type: 'number' },
                  },
                  additionalProperties: false,
                },
                artisan: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    verified: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        DojahNinSelfieManualReviewResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Dojah verification did not go through. Please retry or contact support.' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'rejected' },
                providerStatus: { type: 'string', example: 'failed' },
                failureReason: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        KycStatusResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['pending', 'pending_review', 'approved', 'rejected'] },
                provider: { type: 'string', enum: ['manual', 'dojah', 'dojah_sdk'] },
                verificationType: { type: 'string', example: 'nin_selfie' },
                failureReason: { type: 'string', nullable: true },
                selfieVerification: {
                  type: 'object',
                  properties: {
                    match: { type: 'boolean' },
                    confidenceValue: { type: 'number' },
                    threshold: { type: 'number' },
                  },
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        ArtisanKycStatusResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['not_submitted', 'pending', 'pending_review', 'approved', 'rejected'] },
                provider: { type: 'string', enum: ['manual', 'dojah', 'dojah_sdk'], nullable: true },
                providerStatus: { type: 'string', nullable: true },
                verificationType: { type: 'string', nullable: true },
                failureReason: { type: 'string', nullable: true },
                reviewedBy: { type: 'string', nullable: true },
                submittedAt: { type: 'string', format: 'date-time', nullable: true },
                verifiedAt: { type: 'string', format: 'date-time', nullable: true },
                verified: { type: 'boolean' },
                artisan: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    userId: { type: 'string' },
                    verified: { type: 'boolean' },
                  },
                },
                user: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    kycVerified: { type: 'boolean' },
                    isVerified: { type: 'boolean' },
                    kycLevel: { type: 'number' },
                  },
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        ManualKycMultipartRequest: {
          type: 'object',
          properties: {
            IdType: { type: 'string', example: 'NIN' },
            idNumber: { type: 'string', example: '70123456789' },
            front: { type: 'string', format: 'binary' },
            back: { type: 'string', format: 'binary' },
            selfie: { type: 'string', format: 'binary' },
            document: { type: 'string', format: 'binary' },
          },
          additionalProperties: false,
        },
        ArtisanProfileRequest: {
          type: 'object',
          required: ['trade', 'experience'],
          properties: {
            userId: { type: 'string', description: 'Optional user id when admins create/update another artisan.' },
            trade: { type: 'array', items: { type: 'string' }, example: ['plumbing', 'pipe repair'] },
            experience: { type: 'number', example: 5 },
            certifications: { type: 'array', items: { type: 'string' } },
            bio: { type: 'string' },
            portfolio: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  images: { type: 'array', items: { type: 'string', format: 'uri' } },
                  beforeAfter: { type: 'boolean' },
                },
              },
            },
            serviceArea: {
              type: 'object',
              properties: {
                address: { type: 'string' },
                coordinates: { type: 'array', items: { type: 'number' }, example: [3.3792, 6.5244] },
                radius: { type: 'number', example: 15 },
              },
            },
            pricing: {
              type: 'object',
              properties: {
                perHour: { type: 'number' },
                perJob: { type: 'number' },
              },
            },
            availability: { type: 'array', items: { type: 'string' }, example: ['Mon-Fri', 'Weekends'] },
          },
          additionalProperties: false,
        },
        ArtisanProfileMultipartRequest: {
          allOf: [
            { $ref: '#/components/schemas/ArtisanProfileRequest' },
            {
              type: 'object',
              properties: {
                profileImage: { type: 'string', format: 'binary' },
                portfolioImages: { type: 'array', items: { type: 'string', format: 'binary' } },
              },
            },
          ],
        },
        ChatMessageRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', example: 'Hello, are you available tomorrow?' },
            attachments: { type: 'array', items: { type: 'string', format: 'uri' } },
          },
          additionalProperties: false,
        },
        JobCreateRequest: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', example: 'Fix leaking kitchen sink' },
            categoryId: { type: 'string' },
            description: { type: 'string' },
            trade: { type: 'array', items: { type: 'string' }, example: ['plumbing'] },
            location: { type: 'string', example: 'Lekki Phase 1, Lagos' },
            coordinates: { type: 'array', items: { type: 'number' }, example: [3.4723, 6.4474] },
            budget: { type: 'number', example: 30000 },
            schedule: { type: 'string', example: '2026-05-06T09:00:00.000Z' },
            experienceLevel: { type: 'string', enum: ['entry', 'mid', 'senior'] },
          },
          additionalProperties: false,
        },
        JobUpdateRequest: {
          allOf: [{ $ref: '#/components/schemas/JobCreateRequest' }],
          description: 'Same fields as job creation, all optional for updates.',
        },
        JobApplicationRequest: {
          type: 'object',
          properties: {
            coverNote: { type: 'string' },
            proposedPrice: { type: 'number', example: 25000 },
          },
          additionalProperties: false,
        },
        JobApplicationUpdateRequest: {
          type: 'object',
          properties: {
            coverNote: { type: 'string' },
            proposedPrice: { type: 'number' },
            status: { type: 'string', enum: ['pending', 'withdrawn'] },
          },
          additionalProperties: false,
        },
        PaymentModeRequest: {
          type: 'object',
          properties: {
            paymentMode: { type: 'string', enum: ['upfront', 'afterCompletion'], example: 'upfront' },
          },
          additionalProperties: false,
        },
        CancelReasonRequest: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', example: 'Schedule conflict' },
          },
          additionalProperties: false,
        },
        BookingRequirementRequest: {
          type: 'object',
          properties: {
            note: { type: 'string', example: 'Please bring replacement fittings.' },
            requirements: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        PaymentCreateRequest: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'number', minimum: 0, example: 15000 },
            currency: { type: 'string', example: 'NGN' },
            method: { type: 'string', example: 'paystack' },
            metadata: {
              type: 'object',
              properties: {
                bookingId: { type: 'string' },
                jobId: { type: 'string' },
                specialRequestId: { type: 'string' },
                reason: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        PaymentVerifyRequest: {
          type: 'object',
          required: ['reference'],
          properties: {
            reference: { type: 'string', example: 'trx_123456789' },
            status: { type: 'string', example: 'success' },
          },
        },
        PaymentInitializeRequest: {
          type: 'object',
          properties: {
            amount: { type: 'number', example: 25000 },
            email: { type: 'string', format: 'email' },
            bookingId: { type: 'string' },
            jobId: { type: 'string' },
            specialRequestId: { type: 'string' },
            metadata: {
              type: 'object',
              properties: {
                purpose: { type: 'string', example: 'booking_payment' },
                bookingId: { type: 'string' },
                jobId: { type: 'string' },
                specialRequestId: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        PaystackWebhookRequest: {
          type: 'object',
          required: ['event', 'data'],
          properties: {
            event: { type: 'string', example: 'charge.success' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                reference: { type: 'string' },
                amount: { type: 'number' },
                status: { type: 'string' },
                currency: { type: 'string', example: 'NGN' },
                customer: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', format: 'email' },
                    customer_code: { type: 'string' },
                  },
                  additionalProperties: false,
                },
                metadata: {
                  type: 'object',
                  properties: {
                    bookingId: { type: 'string' },
                    jobId: { type: 'string' },
                    specialRequestId: { type: 'string' },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        WalletAmountRequest: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number', minimum: 0, example: 5000 },
            reason: { type: 'string' },
            reference: { type: 'string' },
          },
          additionalProperties: false,
        },
        DeviceTokenRequest: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'] },
          },
          additionalProperties: false,
        },
        PayoutDetailsRequest: {
          type: 'object',
          properties: {
            bankCode: { type: 'string', example: '058' },
            bankName: { type: 'string', example: 'Guaranty Trust Bank' },
            accountNumber: { type: 'string', example: '0123456789' },
            accountName: { type: 'string', example: 'John Doe' },
          },
          additionalProperties: false,
        },
        NotificationMarkReadRequest: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            id: { type: 'string' },
          },
          additionalProperties: false,
        },
        NotificationCreateRequest: {
          type: 'object',
          required: ['userId', 'title', 'body'],
          properties: {
            userId: { type: 'string' },
            type: { type: 'string', example: 'booking' },
            title: { type: 'string' },
            body: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                bookingId: { type: 'string' },
                jobId: { type: 'string' },
                url: { type: 'string' },
                sendEmail: { type: 'boolean' },
                email: { type: 'string', format: 'email' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        ReviewCreateRequest: {
          type: 'object',
          required: ['rating'],
          properties: {
            artisanId: { type: 'string' },
            bookingId: { type: 'string' },
            jobId: { type: 'string' },
            rating: { type: 'number', minimum: 1, maximum: 5, example: 5 },
            comment: { type: 'string' },
          },
          additionalProperties: false,
        },
        SupportThreadRequest: {
          type: 'object',
          required: ['subject', 'message'],
          properties: {
            subject: { type: 'string', example: 'Payment issue' },
            message: { type: 'string' },
            category: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          additionalProperties: false,
        },
        SupportMessageRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string' },
            attachments: { type: 'array', items: { type: 'string', format: 'uri' } },
          },
          additionalProperties: false,
        },
        UserCreateRequest: {
          type: 'object',
          required: ['email'],
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 6 },
            phone: { type: 'string' },
            role: { type: 'string', enum: ['customer', 'client', 'artisan', 'admin'] },
          },
          additionalProperties: false,
        },
        BookingCreateRequest: {
          type: 'object',
          required: ['artisanId', 'schedule'],
          properties: {
            artisanId: { type: 'string', example: '6624b1b15e0c8c2c64a00001' },
            schedule: { type: 'string', example: '2026-05-05T10:00:00.000Z' },
            price: { type: 'number', example: 25000 },
            notes: { type: 'string' },
            services: {
              type: 'array',
              items: {
                type: 'object',
                required: ['subCategoryId'],
                properties: {
                  subCategoryId: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1, example: 1 },
                },
              },
            },
            categoryId: { type: 'string' },
            subCategoryId: { type: 'string' },
            artisanServiceId: { type: 'string' },
            paymentMode: { type: 'string', enum: ['upfront', 'afterCompletion'] },
          },
          additionalProperties: false,
        },
        BookingHireRequest: {
          allOf: [
            { $ref: '#/components/schemas/BookingCreateRequest' },
            {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', format: 'email' },
                customerCoords: {
                  type: 'object',
                  properties: { lat: { type: 'number' }, lon: { type: 'number' } },
                },
              },
            },
          ],
        },
        QuoteCreateRequest: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'cost'],
                properties: {
                  name: { type: 'string' },
                  qty: { type: 'integer', minimum: 1 },
                  note: { type: 'string' },
                  cost: { type: 'number', minimum: 0 },
                },
              },
            },
            serviceCharge: { type: 'number', minimum: 0 },
            notes: { type: 'string' },
          },
        },
        EmailRequest: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email', example: 'customer@example.com' },
          },
          additionalProperties: false,
        },
        ArtisanServiceRequest: {
          type: 'object',
          properties: {
            categoryId: { type: 'string', example: '6624b1b15e0c8c2c64a00001' },
            services: {
              type: 'array',
              items: {
                type: 'object',
                required: ['subCategoryId', 'price'],
                properties: {
                  subCategoryId: { type: 'string' },
                  price: { type: 'number' },
                  currency: { type: 'string', example: 'NGN' },
                  description: { type: 'string' },
                  notes: { type: 'string' },
                },
              },
            },
          },
          additionalProperties: false,
        },
        PriceSuggestionItem: {
          type: 'object',
          properties: {
            basis: { type: 'string', enum: ['category', 'subcategory'] },
            categoryId: { type: 'string' },
            subCategoryId: { type: 'string', nullable: true },
            currency: { type: 'string', example: 'NGN' },
            artisanCount: { type: 'number', example: 24 },
            totalPrice: { type: 'number', example: 720000 },
            averagePrice: { type: 'number', nullable: true, example: 30000 },
            minimumPrice: { type: 'number', nullable: true, example: 10000 },
            maximumPrice: { type: 'number', nullable: true, example: 75000 },
            suggestedMin: { type: 'number', nullable: true, example: 20000 },
            suggestedMax: { type: 'number', nullable: true, example: 40000 },
            recommendedPrice: { type: 'number', nullable: true, example: 30000 },
            confidence: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
            message: { type: 'string' },
          },
          additionalProperties: false,
        },
        PriceSuggestionResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Price suggestion fetched' },
            data: {
              type: 'object',
              properties: {
                category: {
                  type: 'object',
                  properties: {
                    _id: { type: 'string' },
                    name: { type: 'string', example: 'Plumbing' },
                  },
                  additionalProperties: false,
                },
                subCategory: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    _id: { type: 'string' },
                    name: { type: 'string', example: 'Sink installation' },
                  },
                  additionalProperties: false,
                },
                primaryBasis: { type: 'string', enum: ['category', 'subcategory'] },
                primarySuggestion: { $ref: '#/components/schemas/PriceSuggestionItem' },
                categorySuggestion: { $ref: '#/components/schemas/PriceSuggestionItem' },
                subCategorySuggestion: { $ref: '#/components/schemas/PriceSuggestionItem', nullable: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        SpecialServiceRequestCreateRequest: {
          type: 'object',
          required: ['artisanId', 'description'],
          properties: {
            artisanId: { type: 'string' },
            description: { type: 'string' },
            title: { type: 'string' },
            location: { type: 'string' },
            date: { type: 'string', format: 'date-time' },
            time: { type: 'string' },
            urgency: { type: 'string', enum: ['Normal', 'High', 'Low'] },
            budget: { oneOf: [{ type: 'number' }, { type: 'string' }] },
            categoryId: { type: 'string' },
            categoryName: { type: 'string' },
          },
          additionalProperties: false,
        },
        SpecialServiceRequestMultipartRequest: {
          allOf: [
            { $ref: '#/components/schemas/SpecialServiceRequestCreateRequest' },
            {
              type: 'object',
              properties: {
                file: { type: 'string', format: 'binary' },
                image: { type: 'string', format: 'binary' },
                attachments: { type: 'array', items: { type: 'string', format: 'binary' } },
              },
            },
          ],
        },
        SpecialServiceRequestUpdateRequest: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'responded', 'accepted', 'in_progress', 'completed', 'cancelled', 'rejected', 'declined'] },
            paymentMode: { type: 'string', enum: ['upfront', 'afterCompletion'] },
            note: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    quote: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                    min: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                    max: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                    minQuote: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                    maxQuote: { oneOf: [{ type: 'number' }, { type: 'string' }] },
                    message: { type: 'string' },
                  },
                  additionalProperties: false,
                },
              ],
            },
            selectedPrice: { oneOf: [{ type: 'number' }, { type: 'string' }] },
            title: { type: 'string' },
            description: { type: 'string' },
            location: { type: 'string' },
            date: { type: 'string', format: 'date-time' },
            time: { type: 'string' },
            urgency: { type: 'string', enum: ['Normal', 'High', 'Low'] },
            budget: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          },
          additionalProperties: false,
        },
        SpecialServiceResponseRequest: {
          type: 'object',
          properties: {
            note: { $ref: '#/components/schemas/SpecialServiceRequestUpdateRequest/properties/note' },
            urgency: { type: 'string', enum: ['Normal', 'High', 'Low'] },
          },
          additionalProperties: false,
        },
        AdminCreateRequest: {
          type: 'object',
          required: ['name', 'email', 'password'],
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 6 },
          },
          additionalProperties: false,
        },
        ConfigUpsertRequest: {
          type: 'object',
          required: ['value'],
          properties: {
            value: {
              description: 'Config value. Can be string, number, boolean, object, or array depending on the key.',
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    amount: { type: 'number' },
                    text: { type: 'string' },
                  },
                  additionalProperties: false,
                },
                { type: 'array', items: {} },
              ],
            },
            description: { type: 'string' },
            isPublic: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    paths: buildPaths(),
  };
}

import docsGuard from '../middlewares/swaggerAuth.js';

export default async function swaggerPlugin(fastify, opts) {
  const sendDocumentationHtml = async (_request, reply) => {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Artisan API Documentation</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      html, body { margin: 0; min-height: 100%; background: #f7f8fa; }
      .topbar { display: none; }
      .docs-header {
        align-items: center;
        background: #101828;
        color: #fff;
        display: flex;
        gap: 16px;
        justify-content: space-between;
        padding: 14px 24px;
      }
      .docs-header h1 {
        font: 600 18px/1.3 Arial, sans-serif;
        margin: 0;
      }
      .docs-header nav {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .docs-header a {
        color: #d0d5dd;
        font: 14px/1.4 Arial, sans-serif;
        text-decoration: none;
      }
      .docs-header a:hover { color: #fff; text-decoration: underline; }
      #swagger-ui { max-width: 1460px; margin: 0 auto; }
      .swagger-ui .scheme-container { box-shadow: none; border-bottom: 1px solid #e4e7ec; }
    </style>
  </head>
  <body>
    <header class="docs-header">
      <h1>Artisan API Documentation</h1>
      <nav aria-label="Documentation links">
        <a href="/api/documentation/json">OpenAPI JSON</a>
        <a href="/api/documentation/routes">Route Tree</a>
      </nav>
    </header>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener('load', function () {
        SwaggerUIBundle({
          url: '/api/documentation/json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout',
        });
      });
    </script>
  </body>
</html>`;
    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  };

  const sendRouteTree = async () => ({
    success: true,
    routes: fastify.printRoutes ? fastify.printRoutes() : 'routes info not available',
  });

  // Protect docs routes with docsGuard preHandler
  fastify.get('/documentation/json', { preHandler: docsGuard }, async () => buildOpenApiSpec());
  fastify.get('/api/documentation/json', { preHandler: docsGuard }, async () => buildOpenApiSpec());

  fastify.get('/documentation/routes', { preHandler: docsGuard }, sendRouteTree);
  fastify.get('/api/documentation/routes', { preHandler: docsGuard }, sendRouteTree);

  fastify.get('/documentation', { preHandler: docsGuard }, sendDocumentationHtml);
  fastify.get('/api/documentation', { preHandler: docsGuard }, sendDocumentationHtml);
}

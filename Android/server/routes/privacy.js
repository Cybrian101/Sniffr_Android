import { Router } from 'express';

const router = Router();

// The old one-click delete (POST /api/privacy/delete) deleted an account with
// no email code or confirmation. It is gone: account deletion now lives at
// POST /api/account/delete/request-code + /confirm. Older app builds calling
// this get a clear 410 and nothing is deleted.
router.post('/delete', (req, res) => {
  res.status(410).json({
    error: 'ENDPOINT_REMOVED',
    message: 'This endpoint has been removed. Update the app to delete your account.',
  });
});

export default router;

import { Router, Request, Response } from 'express';
import { DiagnosticsService } from '../services/diagnosticsService';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// ==========================================
// PUBLIC ENDPOINTS (Called by Customer Scanner)
// ==========================================

// GET /api/diagnostics/active-session - Check if an admin diagnostic session is currently active
router.get('/diagnostics/active-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const activeSession = await DiagnosticsService.getActiveSession();
    if (activeSession) {
      res.json({
        active: true,
        sessionId: activeSession.session_id,
        startedAt: activeSession.started_at
      });
    } else {
      res.json({
        active: false,
        sessionId: null,
        startedAt: null
      });
    }
  } catch (error: any) {
    res.status(500).json({
      active: false,
      sessionId: null,
      error: error.message
    });
  }
});

// POST /api/diagnostics/telemetry - Record silent background telemetry during active diagnostic session
router.post('/diagnostics/telemetry', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId, type, data } = req.body;
    if (!sessionId || !type || !data) {
      res.status(400).json({ success: false, message: 'Invalid telemetry payload' });
      return;
    }

    await DiagnosticsService.recordTelemetry({ sessionId, type, data });
    res.json({ success: true });
  } catch (error: any) {
    // Fail silently on public endpoint
    res.json({ success: false, error: error.message });
  }
});

// ==========================================
// ADMIN ENDPOINTS (Authenticated Admin Controls)
// ==========================================

// GET /api/admin/diagnostics/session/active - Get current active diagnostic session details and live counts
router.get('/admin/diagnostics/session/active', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const session = await DiagnosticsService.getActiveSession();
    if (!session) {
      res.json({
        status: 'OFF',
        session: null
      });
      return;
    }

    const startedTime = new Date(session.started_at).getTime();
    const nowTime = Date.now();
    const durationSec = Math.max(0, Math.floor((nowTime - startedTime) / 1000));

    const analysis = await DiagnosticsService.analyzeSession(session.session_id);
    const uniqueDevices = analysis?.summary?.uniqueDevices || 0;
    const newDevices = analysis?.summary?.newDevices || 0;

    res.json({
      status: 'ACTIVE',
      session: {
        sessionId: session.session_id,
        startedAt: session.started_at,
        durationSec: durationSec,
        totalScans: session.total_scans,
        successfulScans: session.successful_scans,
        failedEvents: session.failed_events,
        iosCount: session.ios_count,
        androidCount: session.android_count,
        otherCount: session.other_count,
        uniqueDevices: uniqueDevices,
        newDevices: newDevices,
        createdBy: session.created_by
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/diagnostics/session/start - Start a new diagnostic debug session
router.post('/admin/diagnostics/session/start', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const username = (req as any).user ? (req as any).user.username : 'admin';
    const newSession = await DiagnosticsService.startSession(username);
    res.json({
      success: true,
      message: 'Diagnostic session started successfully',
      session: {
        sessionId: newSession.session_id,
        status: newSession.status,
        startedAt: newSession.started_at,
        createdBy: newSession.created_by
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/diagnostics/session/end - End active diagnostic debug session
router.post('/admin/diagnostics/session/end', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const endedSession = await DiagnosticsService.endSession();
    res.json({
      success: true,
      message: endedSession ? 'Diagnostic session ended' : 'No active session found',
      session: endedSession ? {
        sessionId: endedSession.session_id,
        status: endedSession.status,
        startedAt: endedSession.started_at,
        endedAt: endedSession.ended_at,
        totalScans: endedSession.total_scans,
        successfulScans: endedSession.successful_scans,
        failedEvents: endedSession.failed_events
      } : null
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/diagnostics/sessions - List past diagnostic sessions
router.get('/admin/diagnostics/sessions', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const sessions = await DiagnosticsService.getAllSessions();
    res.json({ success: true, sessions });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/diagnostics/session/:sessionId/analysis - Get comprehensive session analytical report
router.get('/admin/diagnostics/session/:sessionId/analysis', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const analysis = await DiagnosticsService.analyzeSession(req.params.sessionId);
    res.json(analysis);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/diagnostics/session/:sessionId/export - Export raw session diagnostic JSON
router.get('/admin/diagnostics/session/:sessionId/export', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const exportData = await DiagnosticsService.exportSessionData(req.params.sessionId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="diagnostics_${req.params.sessionId}.json"`);
    res.json(exportData);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

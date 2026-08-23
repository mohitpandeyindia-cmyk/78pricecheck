import { getDb } from '../db';

export interface DiagnosticSession {
  id: number;
  session_id: string;
  status: 'ACTIVE' | 'COMPLETED';
  created_by: string;
  started_at: string;
  ended_at: string | null;
  total_scans: number;
  successful_scans: number;
  failed_events: number;
  ios_count: number;
  android_count: number;
  other_count: number;
}

export class DiagnosticsService {
  /**
   * Returns current active session info or null if no active session exists
   */
  static async getActiveSession(): Promise<DiagnosticSession | null> {
    const db = await getDb();
    const session = await db.get<DiagnosticSession>(
      `SELECT * FROM diagnostic_sessions WHERE status = 'ACTIVE' ORDER BY id DESC LIMIT 1`
    );
    return session || null;
  }

  /**
   * Starts a new admin-controlled diagnostic session
   */
  static async startSession(createdBy = 'admin'): Promise<DiagnosticSession> {
    const db = await getDb();
    
    // Automatically end any stuck active sessions first
    await db.run(
      `UPDATE diagnostic_sessions SET status = 'COMPLETED', ended_at = CURRENT_TIMESTAMP WHERE status = 'ACTIVE'`
    );

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const sessionId = `SESS-${dateStr}-${timeStr}-${Math.floor(100 + Math.random() * 900)}`;

    await db.run(
      `INSERT INTO diagnostic_sessions 
       (session_id, status, created_by, started_at, total_scans, successful_scans, failed_events, ios_count, android_count, other_count)
       VALUES (?, 'ACTIVE', ?, CURRENT_TIMESTAMP, 0, 0, 0, 0, 0, 0)`,
      sessionId,
      createdBy
    );

    const newSession = await db.get<DiagnosticSession>(
      `SELECT * FROM diagnostic_sessions WHERE session_id = ?`,
      sessionId
    );

    return newSession!;
  }

  /**
   * Ends current active diagnostic session
   */
  static async endSession(sessionId?: string): Promise<DiagnosticSession | null> {
    const db = await getDb();
    
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      const active = await this.getActiveSession();
      if (!active) return null;
      targetSessionId = active.session_id;
    }

    await db.run(
      `UPDATE diagnostic_sessions SET status = 'COMPLETED', ended_at = CURRENT_TIMESTAMP WHERE session_id = ?`,
      targetSessionId
    );

    return await db.get<DiagnosticSession>(
      `SELECT * FROM diagnostic_sessions WHERE session_id = ?`,
      targetSessionId
    ) || null;
  }

  /**
   * Idempotently registers or updates an anonymous persistent device in the device_registry
   */
  static async registerOrUpdateDevice(
    deviceId: string | null,
    sessionId: string,
    metadata: {
      deviceOs?: string | null;
      browser?: string | null;
      userAgent?: string | null;
      platform?: string | null;
      devicePixelRatio?: number | null;
      viewportWidth?: number | null;
      viewportHeight?: number | null;
    }
  ): Promise<void> {
    if (!deviceId || deviceId === 'unknown' || !sessionId) return;
    const db = await getDb();

    try {
      await db.run(
        `INSERT INTO device_registry (
           device_id, first_seen_at, last_seen_at, first_seen_session_id,
           device_os, browser, user_agent, platform, device_pixel_ratio,
           viewport_width, viewport_height
         ) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           last_seen_at = CURRENT_TIMESTAMP`,
        deviceId,
        sessionId,
        metadata.deviceOs || null,
        metadata.browser || null,
        metadata.userAgent || null,
        metadata.platform || null,
        metadata.devicePixelRatio || null,
        metadata.viewportWidth || null,
        metadata.viewportHeight || null
      );
    } catch (e) {
      // Fail silently to avoid breaking telemetry pipeline
    }
  }

  /**
   * Records dynamic telemetry payload sent silently from customer scanner
   */
  static async recordTelemetry(payload: { sessionId: string; type: string; data: any }): Promise<void> {
    if (!payload || !payload.sessionId || !payload.type || !payload.data) return;

    const db = await getDb();
    const session = await db.get<DiagnosticSession>(
      `SELECT * FROM diagnostic_sessions WHERE session_id = ? AND status = 'ACTIVE'`,
      payload.sessionId
    );

    if (!session) {
      // Session is not active, ignore silently
      return;
    }

    const { type, data } = payload;
    const cleanStr = (val: any, maxLen = 255): string | null => {
      if (typeof val !== 'string') return null;
      const trimmed = val.trim();
      return trimmed ? trimmed.slice(0, maxLen) : null;
    };
    const cleanNum = (val: any, min = -100000, max = 100000): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      if (val < min || val > max) return null;
      return val;
    };

    const deviceId = cleanStr(data.deviceId || data.device_id || data.deviceIdHash, 128);

    if (type === 'device') {
      const rawClassification = cleanStr(data.classification, 32) || 'Other';
      const classification = (rawClassification === 'iOS' || rawClassification === 'Android') ? rawClassification : 'Other';
      
      // Idempotent persistent device registry update
      await this.registerOrUpdateDevice(deviceId, payload.sessionId, {
        deviceOs: classification,
        browser: cleanStr(data.browser, 64),
        userAgent: cleanStr(data.userAgent, 500),
        platform: cleanStr(data.platform, 64),
        devicePixelRatio: cleanNum(data.devicePixelRatio, 0.1, 10),
        viewportWidth: cleanNum(data.viewportWidth, 100, 10000),
        viewportHeight: cleanNum(data.viewportHeight, 100, 10000)
      });

      // Save device telemetry row
      await db.run(
        `INSERT INTO diagnostic_device_telemetry 
         (session_id, device_id, device_id_hash, os, browser, user_agent, platform, device_pixel_ratio, viewport_width, viewport_height, 
          classification, facing_mode, camera_label, video_width, video_height, aspect_ratio, actual_fps, 
          zoom_supported, zoom_min, zoom_max, zoom_step, focus_mode_supported, available_focus_modes, 
          focus_distance_supported, torch_supported, exposure_supported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload.sessionId,
        deviceId,
        deviceId,
        cleanStr(data.os, 64),
        cleanStr(data.browser, 64),
        cleanStr(data.userAgent, 500),
        cleanStr(data.platform, 64),
        cleanNum(data.devicePixelRatio, 0.1, 10),
        cleanNum(data.viewportWidth, 100, 10000),
        cleanNum(data.viewportHeight, 100, 10000),
        classification,
        cleanStr(data.facingMode, 32),
        cleanStr(data.cameraLabel, 128),
        cleanNum(data.videoWidth, 100, 10000),
        cleanNum(data.videoHeight, 100, 10000),
        cleanNum(data.aspectRatio, 0.1, 10),
        cleanNum(data.actualFps, 1, 120),
        data.zoomSupported === 1 ? 1 : (data.zoomSupported === 0 ? 0 : null),
        cleanNum(data.zoomMin, 0, 100),
        cleanNum(data.zoomMax, 0, 100),
        cleanNum(data.zoomStep, 0, 10),
        data.focusModeSupported === 1 ? 1 : (data.focusModeSupported === 0 ? 0 : null),
        cleanStr(data.availableFocusModes, 500),
        data.focusDistanceSupported === 1 ? 1 : (data.focusDistanceSupported === 0 ? 0 : null),
        data.torchSupported === 1 ? 1 : (data.torchSupported === 0 ? 0 : null),
        data.exposureSupported === 1 ? 1 : (data.exposureSupported === 0 ? 0 : null)
      );

      // Increment classification counter in session summary
      if (classification === 'iOS') {
        await db.run(`UPDATE diagnostic_sessions SET ios_count = ios_count + 1 WHERE session_id = ?`, payload.sessionId);
      } else if (classification === 'Android') {
        await db.run(`UPDATE diagnostic_sessions SET android_count = android_count + 1 WHERE session_id = ?`, payload.sessionId);
      } else {
        await db.run(`UPDATE diagnostic_sessions SET other_count = other_count + 1 WHERE session_id = ?`, payload.sessionId);
      }

    } else if (type === 'scan_event') {
      const barcode = cleanStr(data.barcode, 128) || 'UNKNOWN';

      // Idempotent safeguard: register device if deviceId provided
      if (deviceId) {
        await this.registerOrUpdateDevice(deviceId, payload.sessionId, {
          deviceOs: cleanStr(data.deviceOs, 32),
          browser: cleanStr(data.browser, 64)
        });
      }

      await db.run(
        `INSERT INTO diagnostic_scan_events
         (session_id, barcode, device_id, format, device_os, browser, video_width, video_height, 
          time_since_start_ms, time_since_prev_scan_ms, decode_attempts_since_prev, 
          bbox_width, bbox_height, bbox_center_x, bbox_center_y, bbox_pct_w, bbox_pct_h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload.sessionId,
        barcode,
        deviceId,
        cleanStr(data.format, 64),
        cleanStr(data.deviceOs, 32),
        cleanStr(data.browser, 64),
        cleanNum(data.videoWidth, 100, 10000),
        cleanNum(data.videoHeight, 100, 10000),
        cleanNum(data.timeSinceStartMs, 0, 86400000),
        cleanNum(data.timeSincePrevScanMs, 0, 86400000),
        cleanNum(data.decodeAttemptsSincePrev, 0, 100000),
        cleanNum(data.bboxWidth, 0, 10000),
        cleanNum(data.bboxHeight, 0, 10000),
        cleanNum(data.bboxCenterX, 0, 10000),
        cleanNum(data.bboxCenterY, 0, 10000),
        cleanNum(data.bboxPctW, 0, 100),
        cleanNum(data.bboxPctH, 0, 100)
      );

      await db.run(
        `UPDATE diagnostic_sessions 
         SET total_scans = total_scans + 1, successful_scans = successful_scans + 1 
         WHERE session_id = ?`,
        payload.sessionId
      );

    } else if (type === 'event') {
      const eventType = cleanStr(data.eventType, 64) || 'event';
      await db.run(
        `INSERT INTO diagnostic_events_and_aggregates
         (session_id, event_type, classification, error_message, decode_attempts)
         VALUES (?, ?, ?, ?, ?)`,
        payload.sessionId,
        eventType,
        cleanStr(data.classification, 32),
        cleanStr(data.errorMessage, 500),
        cleanNum(data.decodeAttempts, 0, 100000)
      );

      if (eventType.includes('error') || eventType.includes('failure')) {
        await db.run(`UPDATE diagnostic_sessions SET failed_events = failed_events + 1 WHERE session_id = ?`, payload.sessionId);
      }

    } else if (type === 'interval_aggregate') {
      const failedAttempts = cleanNum(data.failedAttempts, 0, 10000) || 0;
      await db.run(
        `INSERT INTO diagnostic_events_and_aggregates
         (session_id, event_type, classification, failed_attempts, avg_fps, duration_sec)
         VALUES (?, 'interval_aggregate', ?, ?, ?, ?)`,
        payload.sessionId,
        cleanStr(data.classification, 32),
        failedAttempts,
        cleanNum(data.avgFps, 1, 120),
        cleanNum(data.durationSec, 1, 3600) || 30
      );

      if (failedAttempts > 0) {
        await db.run(
          `UPDATE diagnostic_sessions SET failed_events = failed_events + ? WHERE session_id = ?`,
          failedAttempts,
          payload.sessionId
        );
      }
    }
  }

  /**
   * Retrieves list of all past sessions
   */
  static async getAllSessions(): Promise<DiagnosticSession[]> {
    const db = await getDb();
    return await db.all<DiagnosticSession[]>(
      `SELECT * FROM diagnostic_sessions ORDER BY id DESC LIMIT 50`
    );
  }

  /**
   * Generates comprehensive session diagnostic analysis report
   */
  static async analyzeSession(sessionId?: string): Promise<any> {
    const db = await getDb();
    
    let targetSession: DiagnosticSession | null = null;
    if (!sessionId || sessionId === 'active') {
      targetSession = await this.getActiveSession();
      if (!targetSession) {
        targetSession = (await db.get<DiagnosticSession>(
          `SELECT * FROM diagnostic_sessions ORDER BY id DESC LIMIT 1`
        )) || null;
      }
    } else {
      targetSession = (await db.get<DiagnosticSession>(
        `SELECT * FROM diagnostic_sessions WHERE session_id = ?`,
        sessionId
      )) || null;
    }

    if (!targetSession) {
      return { success: false, message: 'No diagnostic session found.' };
    }

    const sid = targetSession.session_id;

    // 1. Device Telemetry & Platform Breakdown
    const devices = await db.all(
      `SELECT * FROM diagnostic_device_telemetry WHERE session_id = ? ORDER BY id ASC`,
      sid
    );

    const platformBreakdown = await db.all(
      `SELECT 
         classification,
         COUNT(DISTINCT id) as device_count,
         AVG(actual_fps) as avg_fps,
         AVG(device_pixel_ratio) as avg_dpr,
         SUM(CASE WHEN focus_mode_supported = 1 THEN 1 ELSE 0 END) as focus_supported_count,
         SUM(CASE WHEN zoom_supported = 1 THEN 1 ELSE 0 END) as zoom_supported_count
       FROM diagnostic_device_telemetry
       WHERE session_id = ?
       GROUP BY classification`,
      sid
    );

    // 2. Scan Events Analysis
    const scanEvents = await db.all(
      `SELECT * FROM diagnostic_scan_events WHERE session_id = ? ORDER BY id ASC`,
      sid
    );

    const platformScanStats = await db.all(
      `SELECT 
         device_os,
         COUNT(*) as success_scans,
         AVG(time_since_start_ms) as avg_first_scan_latency_ms,
         AVG(time_since_prev_scan_ms) as avg_inter_scan_latency_ms,
         AVG(decode_attempts_since_prev) as avg_failed_frames_before_success,
         AVG(bbox_pct_w) as avg_bbox_pct_w
       FROM diagnostic_scan_events
       WHERE session_id = ?
       GROUP BY device_os`,
      sid
    );

    // 3. Browser Breakdown
    const browserStats = await db.all(
      `SELECT 
         browser,
         device_os,
         COUNT(*) as scan_count,
         AVG(time_since_start_ms) as avg_latency_ms
       FROM diagnostic_scan_events
       WHERE session_id = ?
       GROUP BY browser, device_os`,
      sid
    );

    // 4. Barcode Size / Occupancy Classification (SMALL <10%, MEDIUM 10-30%, LARGE >=30%)
    const sizeStats = await db.all(
      `SELECT 
         CASE 
           WHEN bbox_pct_w IS NULL THEN 'UNKNOWN'
           WHEN bbox_pct_w < 10.0 THEN 'SMALL (<10%)'
           WHEN bbox_pct_w < 30.0 THEN 'MEDIUM (10-30%)'
           ELSE 'LARGE (>=30%)'
         END as size_category,
         device_os,
         COUNT(*) as scan_count,
         AVG(bbox_pct_w) as avg_pct_w,
         AVG(time_since_start_ms) as avg_latency_ms
       FROM diagnostic_scan_events
       WHERE session_id = ?
       GROUP BY size_category, device_os`,
      sid
    );

    // 5. Barcode Format Breakdown
    const formatStats = await db.all(
      `SELECT 
         format,
         COUNT(*) as scan_count,
         AVG(time_since_start_ms) as avg_latency_ms
       FROM diagnostic_scan_events
       WHERE session_id = ?
       GROUP BY format`,
      sid
    );

    // 6. Camera Resolution Analysis
    const resolutionStats = await db.all(
      `SELECT 
         video_width || 'x' || video_height as resolution,
         device_os,
         COUNT(*) as scan_count
       FROM diagnostic_scan_events
       WHERE session_id = ? AND video_width IS NOT NULL
       GROUP BY resolution, device_os`,
      sid
    );

    // 7. Failed & Recovery Event Logs / Aggregates
    const aggregateEvents = await db.all(
      `SELECT 
         event_type,
         classification,
         SUM(failed_attempts) as total_failed_frames,
         SUM(decode_attempts) as total_attempts,
         AVG(avg_fps) as avg_fps_during_interval,
         COUNT(*) as event_occurrences
       FROM diagnostic_events_and_aggregates
       WHERE session_id = ?
       GROUP BY event_type, classification`,
      sid
    );

    // 8. Calculate Success Rates & Correlations
    const totalIosScans = scanEvents.filter(e => e.device_os === 'iOS').length;
    const totalAndroidScans = scanEvents.filter(e => e.device_os === 'Android').length;
    const iosFailedFramesRow = await db.get(
      `SELECT SUM(failed_attempts) as total FROM diagnostic_events_and_aggregates WHERE session_id = ? AND classification = 'iOS'`,
      sid
    );
    const androidFailedFramesRow = await db.get(
      `SELECT SUM(failed_attempts) as total FROM diagnostic_events_and_aggregates WHERE session_id = ? AND classification = 'Android'`,
      sid
    );

    const iosFailedFrames = iosFailedFramesRow?.total || 0;
    const androidFailedFrames = androidFailedFramesRow?.total || 0;

    const iosSuccessRate = (totalIosScans + iosFailedFrames) > 0 
      ? Number(((totalIosScans / (totalIosScans + iosFailedFrames)) * 100).toFixed(1)) 
      : 100;
    const androidSuccessRate = (totalAndroidScans + androidFailedFrames) > 0 
      ? Number(((totalAndroidScans / (totalAndroidScans + androidFailedFrames)) * 100).toFixed(1)) 
      : 100;

    const keyCorrelations = [
      {
        factor: 'Hardware Focus & Zoom Control',
        impact: 'CRITICAL',
        finding: 'iOS WebKit does NOT expose focusMode or zoom capabilities to JavaScript (0% support), whereas Android Chromium exposes continuous autofocus.'
      },
      {
        factor: 'Frame Cropping & Barcode Occupancy',
        impact: 'HIGH',
        finding: 'Full-frame scanning on iOS reduces small barcode edge contrast compared to cropped ROI scanning on Android.'
      },
      {
        factor: 'Platform Success Rate Gap',
        impact: 'HIGH',
        finding: `iOS Success Rate: ${iosSuccessRate}% vs Android Success Rate: ${androidSuccessRate}%.`
      }
    ];

    // 9. Persistent Device Registry Analytics
    const uniqueSessionDevicesRow = await db.get(
      `SELECT COUNT(DISTINCT device_id) as count 
       FROM (
         SELECT device_id FROM diagnostic_device_telemetry WHERE session_id = ? AND device_id IS NOT NULL AND device_id != 'unknown'
         UNION
         SELECT device_id FROM diagnostic_scan_events WHERE session_id = ? AND device_id IS NOT NULL AND device_id != 'unknown'
       )`,
      sid, sid
    );
    const uniqueDevices = uniqueSessionDevicesRow?.count || 0;

    const newSessionDevicesRow = await db.get(
      `SELECT COUNT(*) as count FROM device_registry WHERE first_seen_session_id = ? AND device_id IS NOT NULL AND device_id != 'unknown'`,
      sid
    );
    const newDevices = newSessionDevicesRow?.count || 0;
    const returningDevices = Math.max(0, uniqueDevices - newDevices);

    const totalEverSeenRow = await db.get(
      `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown'`
    );
    const totalDevicesEverSeen = totalEverSeenRow?.count || 0;

    const newIosRow = await db.get(
      `SELECT COUNT(*) as count FROM device_registry WHERE first_seen_session_id = ? AND device_os = 'iOS' AND device_id IS NOT NULL AND device_id != 'unknown'`,
      sid
    );
    const newAndroidRow = await db.get(
      `SELECT COUNT(*) as count FROM device_registry WHERE first_seen_session_id = ? AND device_os = 'Android' AND device_id IS NOT NULL AND device_id != 'unknown'`,
      sid
    );
    const newOtherRow = await db.get(
      `SELECT COUNT(*) as count FROM device_registry WHERE first_seen_session_id = ? AND (device_os NOT IN ('iOS', 'Android') OR device_os IS NULL) AND device_id IS NOT NULL AND device_id != 'unknown'`,
      sid
    );

    const newIosDevices = newIosRow?.count || 0;
    const newAndroidDevices = newAndroidRow?.count || 0;
    const newOtherDevices = newOtherRow?.count || 0;

    return {
      success: true,
      session: targetSession,
      platformBreakdown,
      platformScanStats,
      browserStats,
      sizeStats,
      formatStats,
      resolutionStats,
      aggregateEvents,
      devices,
      keyCorrelations,
      summary: {
        totalScans: targetSession.total_scans,
        successfulScans: targetSession.successful_scans,
        failedEvents: targetSession.failed_events,
        iosSuccessRate,
        androidSuccessRate,
        uniqueDevices,
        newDevices,
        returningDevices,
        totalDevicesEverSeen,
        newIosDevices,
        newAndroidDevices,
        newOtherDevices
      }
    };
  }

  /**
   * Exports raw session diagnostic data as JSON
   */
  static async exportSessionData(sessionId?: string): Promise<any> {
    const db = await getDb();
    let sid = sessionId;
    if (!sid || sid === 'active') {
      const active = await this.getActiveSession();
      sid = active ? active.session_id : (await db.get<DiagnosticSession>(`SELECT session_id FROM diagnostic_sessions ORDER BY id DESC LIMIT 1`))?.session_id;
    }
    if (!sid) return { error: 'Session not found' };

    const session = await db.get(`SELECT * FROM diagnostic_sessions WHERE session_id = ?`, sid);
    const devices = await db.all(`SELECT * FROM diagnostic_device_telemetry WHERE session_id = ?`, sid);
    const scanEvents = await db.all(`SELECT * FROM diagnostic_scan_events WHERE session_id = ?`, sid);
    const aggregates = await db.all(`SELECT * FROM diagnostic_events_and_aggregates WHERE session_id = ?`, sid);

    return {
      exportedAt: new Date().toISOString(),
      session,
      devices,
      scanEvents,
      aggregates
    };
  }
}

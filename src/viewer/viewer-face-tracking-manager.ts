import * as pc from 'playcanvas';
import { FaceTracker } from '../utils/face-tracker';
import type { Viewer } from '../main';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles face tracking camera control and orbit mode sync.
 */
export class ViewerFaceTrackingManager {
    faceTracker: FaceTracker;
    isFaceTracking = false;
    faceTrackingBasePos = new pc.Vec3();
    faceTrackingBaseRight = new pc.Vec3();
    faceTrackingBaseUp = new pc.Vec3();
    faceTrackingTarget = new pc.Vec3();
    faceTrackingOffset = new pc.Vec3();
    faceTrackingScale = 5.0;
    faceTrackingInvertX = true;
    faceTrackingInvertY = true;

    constructor(private viewer: Viewer) {
        this.faceTracker = new FaceTracker('face-tracker-video', (pos) => {
            if (this.isFaceTracking) {
                const targetX = (this.faceTrackingInvertX ? -pos.x : pos.x) * this.faceTrackingScale;
                const targetY = (this.faceTrackingInvertY ? -pos.y : pos.y) * this.faceTrackingScale * 0.7;
                this.faceTrackingOffset.x = pc.math.lerp(this.faceTrackingOffset.x, targetX, 0.1);
                this.faceTrackingOffset.y = pc.math.lerp(this.faceTrackingOffset.y, targetY, 0.1);
            }
        });
    }

    /** Called each frame from the main onUpdate loop. */
    update() {
        const v = this.viewer as any;
        if (this.isFaceTracking && v.camera) {
            const rightOffset = this.faceTrackingBaseRight.clone();
            rightOffset.mulScalar(this.faceTrackingOffset.x);

            const upOffset = this.faceTrackingBaseUp.clone();
            upOffset.mulScalar(this.faceTrackingOffset.y);

            const targetPos = this.faceTrackingBasePos.clone().add(rightOffset).add(upOffset);

            v.camera.setPosition(targetPos);
            v.camera.lookAt(this.faceTrackingTarget);
        }
    }

    syncOrbitFromCamera() {
        const v = this.viewer as any;
        if (!v.camera) return;
        const pos = v.camera.getPosition().clone();
        const dist = pos.length();
        if (dist <= 0.0001) return;
        const dir = pos.clone().mulScalar(1 / dist);
        v.orbitDistance = Math.max(1.0, dist);
        v.yaw = Math.atan2(dir.x, dir.z) * pc.math.RAD_TO_DEG;
        v.pitch = -Math.asin(pc.math.clamp(dir.y, -1, 1)) * pc.math.RAD_TO_DEG;
        v.orbitCameraUpdates();
    }
}

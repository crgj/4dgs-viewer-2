import * as pc from 'playcanvas';
import type { Viewer } from '../main';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles scene setup (grid, axes), camera reset, and orbit updates.
 */
export class ViewerSceneManager {
    constructor(private viewer: Viewer) {}

    setupScene() {
        const v = this.viewer as any;
        const app = v.app;

        const camera = new pc.Entity('Camera');
        camera.addComponent('camera', {
            clearColor: new pc.Color(0.1, 0.1, 0.1, 1),
            farClip: 1000,
            nearClip: 0.1,
            fov: 60
        });

        camera.setPosition(0, 1, 5);
        app.root.addChild(camera);
        v.camera = camera;

        this.initGrid();
        this.initAxes();
    }

    initGrid() {
        const v = this.viewer as any;
        const size = 20;
        const divisions = 40;
        const color = new pc.Color(0.2, 0.2, 0.2, 1);

        const positions: number[] = [];
        for (let i = 0; i <= divisions; i++) {
            const coord = (i / divisions - 0.5) * size;
            positions.push(coord, 0, -size / 2, coord, 0, size / 2);
            positions.push(-size / 2, 0, coord, size / 2, 0, coord);
        }

        const mesh = new pc.Mesh(v.app.graphicsDevice);
        mesh.setPositions(new Float32Array(positions));
        mesh.update(pc.PRIMITIVE_LINES);

        const material = new pc.BasicMaterial();
        material.color = color;
        material.blendType = pc.BLEND_NONE;
        material.depthWrite = true;
        material.update();

        const entity = new pc.Entity('Grid');
        entity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(mesh, material)]
        });

        v.app.root.addChild(entity);
        v.gridEntity = entity;
    }

    initAxes() {
        const v = this.viewer as any;
        const length = 1.0;
        const thickness = 0.015;
        const entity = new pc.Entity('Axes');

        const createAxis = (name: string, pos: pc.Vec3, scale: pc.Vec3, color: pc.Color) => {
            const axis = new pc.Entity(name);
            axis.addComponent('render', {
                type: 'box'
            });
            axis.setLocalPosition(pos);
            axis.setLocalScale(scale);

            const material = new pc.BasicMaterial();
            material.color = color;
            material.depthWrite = true;
            material.blendType = pc.BLEND_NONE;
            material.update();

            if (axis.render) {
                axis.render.meshInstances[0].material = material;
            }

            entity.addChild(axis);
        };

        createAxis('AxisX', new pc.Vec3(length / 2, 0, 0), new pc.Vec3(length, thickness, thickness), new pc.Color(1, 0, 0));
        createAxis('AxisY', new pc.Vec3(0, length / 2, 0), new pc.Vec3(thickness, length, thickness), new pc.Color(0, 1, 0));
        createAxis('AxisZ', new pc.Vec3(0, 0, length / 2), new pc.Vec3(thickness, thickness, length), new pc.Color(0, 0, 1));

        v.app.root.addChild(entity);
        v.axesEntity = entity;
    }

    resetCamera() {
        const v = this.viewer as any;
        if (!v.camera) return;
        if (v.arHandler && v.arHandler.isARRunning) return;

        if (v.isOrbitMode) {
            v.orbitDistance = 5.0;
            v.pitch = 0;
            v.yaw = 0;
            this.orbitCameraUpdates();
        } else {
            // #WDD-gpt 2026-04-20 - 修复重构后 cameraPresets 挪到 presetManager 导致 resetCamera 读取 undefined.length
            const presets = v?.presetManager?.cameraPresets;
            if (Array.isArray(presets) && presets.length > 0) {
                const first = presets[0];
                v.camera.setPosition(first.pos);
                v.pitch = first.pitch;
                v.yaw = first.yaw;
                v.camera.setLocalEulerAngles(v.pitch, v.yaw, 0);
                return;
            }
            v.camera.setPosition(0, 1, 5);
            v.camera.setEulerAngles(0, 0, 0);
            v.pitch = 0;
            v.yaw = 0;
        }
    }

    orbitCameraUpdates() {
        const v = this.viewer as any;
        if (!v.camera) return;

        const rot = new pc.Quat().setFromEulerAngles(v.pitch, v.yaw, 0);
        const dir = new pc.Vec3(0, 0, 1);

        const q = new pc.Quat().setFromEulerAngles(v.pitch, v.yaw, 0);
        const offset = new pc.Vec3(0, 0, v.orbitDistance);
        q.transformVector(offset, offset);

        v.camera.setPosition(offset);
        v.camera.lookAt(pc.Vec3.ZERO);
    }
}

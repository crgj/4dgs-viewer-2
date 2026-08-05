export interface DisplayModelPreset {
    cameraPosition: readonly [number, number, number];
    cameraTarget: readonly [number, number, number];
    fov: number;
    distanceScale: number;
}

// #WDD-gpt 2026-08-04 - 保留 public/sog 各模型发布时的最佳观察位姿，模型归一化后会同步换算这些坐标
const DISPLAY_MODEL_PRESETS: Readonly<Record<string, DisplayModelPreset>> = {
    'bard-duo.sog': {
        cameraPosition: [9.213887214660645, 0.15756595134735107, 0.23042260110378265],
        cameraTarget: [0.005700230598449707, -0.003218650817871096, -0.010702252388000488],
        fov: 75,
        distanceScale: 1.25
    },
    'diy-scan-rig.sog': {
        cameraPosition: [-13.560484886169434, 8.870820999145508, -0.9613013863563538],
        cameraTarget: [-0.10575412823835073, 0.9005739136391053, -0.8368268570204453],
        fov: 75,
        distanceScale: 1.25
    },
    'japanese-bee.sog': {
        cameraPosition: [0.48512017726898193, 1.0372594594955444, 0.5693928599357605],
        cameraTarget: [0.07303313726607685, -0.06620827299322782, -0.036974788434993855],
        fov: 40,
        distanceScale: 2
    },
    'lion.sog': {
        cameraPosition: [0.41889622807502747, 0.32841917872428894, -1.0526024103164673],
        cameraTarget: [-0.03593274363781601, 0.17895434367770183, -0.0488698758959365],
        fov: 63,
        distanceScale: 1.12
    },
    'mothers-day.sog': {
        cameraPosition: [1.8871252536773682, 23.080245971679688, -13.127573013305664],
        cameraTarget: [-0.961115818989826, 8.787568456361267, -3.0621680327793346],
        fov: 75,
        distanceScale: 1.45
    },
    'rhynocoris.sog': {
        cameraPosition: [0.21535679697990417, 0.19181904196739197, -0.28882545232772827],
        cameraTarget: [0.03938771730903656, -0.053671472538673826, 0.008600702329051912],
        fov: 75,
        distanceScale: 1.35
    },
    'seedance-splat.sog': {
        cameraPosition: [-0.22840021550655365, -0.7495506405830383, -4.840981960296631],
        cameraTarget: [-0.09268091908395187, -0.7377490769009674, -2.8456272341027002],
        fov: 85,
        distanceScale: 1
    },
    'sleepy-art-toy.sog': {
        cameraPosition: [6.217300891876221, 2.09126877784729, -0.579351544380188],
        cameraTarget: [-0.07361498808239819, -0.26356246856695664, 0.18360466637564787],
        fov: 75,
        distanceScale: 1.6
    }
};

export const getDisplayModelPreset = (fileName: string): DisplayModelPreset | null => {
    const normalizedName = fileName.trim().toLowerCase().split(/[\\/]/).pop() || '';
    return DISPLAY_MODEL_PRESETS[normalizedName] || null;
};

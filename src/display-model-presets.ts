export interface DisplayModelPreset {
    cameraPosition: readonly [number, number, number];
    cameraTarget: readonly [number, number, number];
    fov: number;
    distanceScale: number;
}

// #WDD-gpt 2026-08-04 - 保留 public/sog 各模型发布时的最佳观察位姿，模型归一化后会同步换算这些坐标
const DISPLAY_MODEL_PRESETS: Readonly<Record<string, DisplayModelPreset>> = {
    // #WDD-gpt  2026-08-10 - 新增 SOG 复用其 SuperSplat 发布相机位姿，统一相册构图与打开后的初始视角
    '152mm-gaubitsa.sog': {
        cameraPosition: [4.036492347717285, 0.5997912883758545, 1.674768090248108],
        cameraTarget: [0.127948355854957, 0.1605007112401829, -4.17552655107195],
        fov: 75,
        distanceScale: 1
    },
    'bard-duo.sog': {
        cameraPosition: [9.213887214660645, 0.15756595134735107, 0.23042260110378265],
        cameraTarget: [0.005700230598449707, -0.003218650817871096, -0.010702252388000488],
        fov: 75,
        distanceScale: 1.25
    },
    'bonsai tree.sog': {
        cameraPosition: [-0.4494137763977051, 0.8143764734268188, 2.5208582878112793],
        cameraTarget: [-0.30755712984214967, 0.625414848747568, 1.374978865869034],
        fov: 59,
        distanceScale: 1
    },
    'container.sog': {
        cameraPosition: [-0.009611096233129501, 0.08374148607254028, -0.3403610587120056],
        cameraTarget: [-0.009010673478944041, 0.04261272924618719, 0.15847479323552516],
        fov: 75,
        distanceScale: 1.35
    },
    'diy-scan-rig.sog': {
        cameraPosition: [-13.560484886169434, 8.870820999145508, -0.9613013863563538],
        cameraTarget: [-0.10575412823835073, 0.9005739136391053, -0.8368268570204453],
        fov: 75,
        distanceScale: 1.25
    },
    '_houdini elektra test.sog': {
        cameraPosition: [-3.091968059539795, 11.439929008483887, -24.115924835205078],
        cameraTarget: [-3.1330819157633143, 11.342752955179064, -20.65343070403765],
        fov: 77,
        distanceScale: 1.12
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
    'mi-8.sog': {
        cameraPosition: [-0.9515010714530945, 2.68928861618042, 9.24109935760498],
        cameraTarget: [0.9577479550937402, 2.0734025661718505, -1.4764529243422722],
        fov: 75,
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
    },
    'strawberry.sog': {
        cameraPosition: [3.4749960899353027, 1.3445059061050415, 0.5792767405509949],
        cameraTarget: [-0.31437902919022775, 0.15108696447442685, 0.2010468036092341],
        fov: 60,
        distanceScale: 1.12
    },
    't34-85.sog': {
        cameraPosition: [3.870826482772827, 1.0689589977264404, 3.9230387210845947],
        cameraTarget: [0.5725897609351174, 0.7825676891836431, -3.5393998537949463],
        fov: 75,
        distanceScale: 1
    },
    'tribal fantasy shaman female bust - reconstructed with seeget3d.sog': {
        cameraPosition: [-8.467833518981934, 2.0701301097869873, -1.346980094909668],
        cameraTarget: [0.013093331451439594, 0.008659388238521526, -0.0037331415934874768],
        fov: 70,
        distanceScale: 1.15
    },
    'zelda.sog': {
        cameraPosition: [0.7795584201812744, 0.17163841426372528, -6.8572587966918945],
        cameraTarget: [-0.0011190893576970007, -0.5182559952549768, -0.2148114619114141],
        fov: 75,
        distanceScale: 1.08
    }
};

export const getDisplayModelPreset = (fileName: string): DisplayModelPreset | null => {
    const normalizedName = fileName.trim().toLowerCase().split(/[\\/]/).pop() || '';
    return DISPLAY_MODEL_PRESETS[normalizedName] || null;
};

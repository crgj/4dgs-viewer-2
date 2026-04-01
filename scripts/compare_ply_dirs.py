import json
import struct
import sys
from pathlib import Path

TYPE_SIZES = {
    'char': 1, 'uchar': 1, 'int8': 1, 'uint8': 1,
    'short': 2, 'ushort': 2, 'int16': 2, 'uint16': 2,
    'int': 4, 'uint': 4, 'int32': 4, 'uint32': 4,
    'float': 4, 'float32': 4, 'double': 8, 'float64': 8,
}

FMT_MAP = {
    'char': 'b', 'uchar': 'B', 'int8': 'b', 'uint8': 'B',
    'short': 'h', 'ushort': 'H', 'int16': 'h', 'uint16': 'H',
    'int': 'i', 'uint': 'I', 'int32': 'i', 'uint32': 'I',
    'float': 'f', 'float32': 'f', 'double': 'd', 'float64': 'd',
}


def read_ply(path: Path):
    with path.open('rb') as f:
        header_lines = []
        while True:
            line = f.readline()
            if not line:
                raise RuntimeError(f'{path}: unexpected EOF in header')
            text = line.decode('ascii').rstrip('\n')
            header_lines.append(text)
            if text == 'end_header':
                break

        vertex_count = None
        props = []
        in_vertex = False
        for line in header_lines:
            parts = line.strip().split()
            if not parts:
                continue
            if parts[0] == 'element':
                in_vertex = parts[1] == 'vertex'
                if in_vertex:
                    vertex_count = int(parts[2])
            elif parts[0] == 'property' and in_vertex:
                if parts[1] == 'list':
                    raise RuntimeError(f'{path}: list property unsupported')
                props.append((parts[2], parts[1]))

        row_size = sum(TYPE_SIZES[t] for _, t in props)
        body = f.read()
        expected = vertex_count * row_size
        if len(body) != expected:
            raise RuntimeError(f'{path}: body size mismatch got {len(body)} expected {expected}')

        arrays = {name: [] for name, _ in props}
        offset = 0
        for _ in range(vertex_count):
            for name, typ in props:
                arrays[name].append(struct.unpack_from('<' + FMT_MAP[typ], body, offset)[0])
                offset += TYPE_SIZES[typ]

        return {
            'vertex_count': vertex_count,
            'props': [name for name, _ in props],
            'arrays': arrays,
        }


def compare_frame(ref_path: Path, test_path: Path):
    ref = read_ply(ref_path)
    test = read_ply(test_path)
    result = {
        'frame': ref_path.name,
        'same': True,
        'issues': [],
    }

    if ref['vertex_count'] != test['vertex_count']:
        result['same'] = False
        result['issues'].append({
            'type': 'count',
            'ref': ref['vertex_count'],
            'test': test['vertex_count'],
        })

    if ref['props'] != test['props']:
        result['same'] = False
        result['issues'].append({
            'type': 'props',
            'ref': ref['props'],
            'test': test['props'],
        })

    common_props = [p for p in ref['props'] if p in test['props']]
    for prop in common_props:
        ra = ref['arrays'][prop]
        ta = test['arrays'][prop]
        if len(ra) != len(ta):
            result['same'] = False
            result['issues'].append({
                'type': 'len',
                'prop': prop,
                'ref': len(ra),
                'test': len(ta),
            })
            continue

        diff_count = 0
        first_idx = None
        first_ref = None
        first_test = None
        max_abs = 0.0
        for idx, (rv, tv) in enumerate(zip(ra, ta)):
            if rv != tv:
                diff_count += 1
                delta = abs(rv - tv)
                if delta > max_abs:
                    max_abs = delta
                if first_idx is None:
                    first_idx = idx
                    first_ref = rv
                    first_test = tv

        if diff_count:
            result['same'] = False
            result['issues'].append({
                'type': 'prop_values',
                'prop': prop,
                'diff_count': diff_count,
                'first_idx': first_idx,
                'ref': first_ref,
                'test': first_test,
                'max_abs': max_abs,
            })

    return result


def main():
    ref_dir = Path(sys.argv[1])
    test_dir = Path(sys.argv[2])
    start = int(sys.argv[3])
    end = int(sys.argv[4])

    results = []
    for i in range(start, end + 1):
        name = f'frame_{i:04d}.ply'
        results.append(compare_frame(ref_dir / name, test_dir / name))

    summary = {
        'same_frames': sum(1 for item in results if item['same']),
        'total_frames': len(results),
        'frames': results,
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()

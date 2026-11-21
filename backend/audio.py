"""WAV validation helpers for Gnani PCM audio."""
import io
import struct
import wave


def normalize_gnani_wav(data: bytes) -> bytes:
    """Repair valid streaming WAV headers that use unknown RIFF/data sizes."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Gnani did not return a WAV file")
    declared = struct.unpack_from("<I", data, 4)[0]
    if declared != 0xFFFFFFFF and declared + 8 != len(data):
        raise ValueError("Gnani returned an incomplete WAV file")
    offset, pcm, fmt = 12, None, None
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]; size = struct.unpack_from("<I", data, offset + 4)[0]; offset += 8
        if size == 0xFFFFFFFF:
            if kind != b"data": raise ValueError("Gnani WAV has an invalid unknown-length chunk")
            size = len(data) - offset
        if offset + size > len(data): raise ValueError("Gnani WAV is truncated")
        if kind == b"fmt ": fmt = data[offset:offset + size]
        if kind == b"data":
            if pcm is not None: raise ValueError("Gnani WAV has duplicate audio chunks")
            pcm = data[offset:offset + size]
        offset += size + size % 2
    if offset != len(data) or fmt is None or len(fmt) < 16 or not pcm: raise ValueError("Gnani WAV is incomplete")
    encoding, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if (encoding, channels, rate, bits, align, byte_rate) != (1, 1, 24000, 16, 2, 48000): raise ValueError("Gnani WAV uses an unexpected format")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels); wav.setsampwidth(bits // 8); wav.setframerate(rate); wav.writeframes(pcm)
    return output.getvalue()

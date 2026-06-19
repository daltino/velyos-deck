#!/usr/bin/env python3
"""Native MIDI bridge for the browser DJ deck.

The browser UI talks to this helper over localhost WebSocket. The helper talks
to CoreMIDI through python-rtmidi, so DDJ-SB3 detection and LED output do not
depend on Chrome's WebMIDI device exposure.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse


DDJ_SB3_NAME_MARKERS = ("ddj-sb3", "ddj sb3", "pioneer dj")


def _is_ddj_sb3_name(name: str) -> bool:
    folded = name.lower()
    return any(marker in folded for marker in DDJ_SB3_NAME_MARKERS)


@dataclass
class MidiDeviceState:
    inputs: list[str]
    outputs: list[str]
    input_name: str | None
    output_name: str | None


class NativeMidiBridge:
    """Run a DDJ-SB3 CoreMIDI bridge on a background WebSocket server."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0):
        self.host = host
        self.requested_port = port
        self.port: int | None = None
        self.url: str | None = None
        self.error: str | None = None
        self.available = False

        self._ready = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._clients: set[Any] = set()

        self._rtmidi = None
        self._midi_in = None
        self._midi_out = None
        self._state = MidiDeviceState([], [], None, None)
        self._send_lock = threading.Lock()

    # ------------------------------------------------------------------ API
    def start(self, timeout: float = 3.0) -> bool:
        if self._thread and self._thread.is_alive():
            return self.available
        self._thread = threading.Thread(target=self._thread_main, daemon=True)
        self._thread.start()
        self._ready.wait(timeout)
        return self.available

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(lambda: None)
        if self._thread:
            self._thread.join(timeout)
        self._close_midi()

    def runtime_info(self) -> dict[str, Any]:
        return {
            "midi_ws_url": self.url if self.available else None,
            "native_midi_available": bool(self.available),
            "native_midi_error": self.error,
        }

    # ------------------------------------------------------------- lifecycle
    def _thread_main(self) -> None:
        try:
            asyncio.run(self._run())
        except Exception as exc:
            self.error = str(exc)
            self.available = False
            self._ready.set()
            self._close_midi()

    async def _run(self) -> None:
        try:
            import rtmidi  # type: ignore
            import websockets  # type: ignore
        except Exception as exc:
            self.error = (
                "Native MIDI dependencies missing. Install requirements.txt "
                f"(import error: {exc})"
            )
            self.available = False
            self._ready.set()
            return

        self._rtmidi = rtmidi
        self._loop = asyncio.get_running_loop()
        self._rescan_midi()

        async with websockets.serve(self._handle_client, self.host, self.requested_port) as server:
            sock = server.sockets[0]
            self.port = int(sock.getsockname()[1])
            self.url = f"ws://{self.host}:{self.port}/midi"
            self.available = True
            self.error = None
            self._ready.set()
            last_poll = 0.0
            while not self._stop.is_set():
                now = time.time()
                if now - last_poll > 1.0:
                    last_poll = now
                    if self._ports_changed():
                        self._rescan_midi()
                        await self._broadcast({
                            "type": "diagnostic",
                            "coremidi_inputs": self._state.inputs,
                            "coremidi_outputs": self._state.outputs,
                        })
                        await self._broadcast(self._device_event())
                await asyncio.sleep(0.2)

    # --------------------------------------------------------------- WebSocket
    async def _handle_client(self, websocket, *_args) -> None:
        if not self._websocket_origin_allowed(websocket):
            await websocket.close(code=1008, reason="cross-origin blocked")
            return
        self._clients.add(websocket)
        try:
            await self._send(websocket, {
                "type": "ready",
                "devices": self._device_payload(),
                "selected": self._selected_payload(),
            })
            await self._send(websocket, self._device_event())
            async for raw in websocket:
                await self._handle_browser_message(raw)
        finally:
            self._clients.discard(websocket)

    async def _handle_browser_message(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        msg_type = msg.get("type")
        if msg_type == "send":
            data = msg.get("data")
            if self._valid_midi_bytes(data):
                self.send_midi(data)
        elif msg_type == "rescan":
            self._rescan_midi()
            await self._broadcast({
                "type": "diagnostic",
                "coremidi_inputs": self._state.inputs,
                "coremidi_outputs": self._state.outputs,
            })
            await self._broadcast(self._device_event())

    @staticmethod
    def _websocket_origin_allowed(websocket) -> bool:
        origin = None
        headers = getattr(websocket, "request_headers", None)
        if headers is not None:
            origin = headers.get("Origin")
        if origin is None:
            request = getattr(websocket, "request", None)
            request_headers = getattr(request, "headers", None)
            if request_headers is not None:
                origin = request_headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urlparse(origin)
        except ValueError:
            return False
        return parsed.hostname in {"127.0.0.1", "localhost", "::1"}

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        if not self._clients:
            return
        dead = []
        for websocket in list(self._clients):
            try:
                await self._send(websocket, payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self._clients.discard(websocket)

    @staticmethod
    async def _send(websocket, payload: dict[str, Any]) -> None:
        await websocket.send(json.dumps(payload, separators=(",", ":")))

    # ------------------------------------------------------------------ MIDI
    def _rescan_midi(self) -> None:
        self._close_midi()
        if not self._rtmidi:
            return

        midi_in = self._rtmidi.MidiIn()
        midi_out = self._rtmidi.MidiOut()
        inputs = list(midi_in.get_ports())
        outputs = list(midi_out.get_ports())
        input_idx = self._first_ddj_index(inputs)
        output_idx = self._first_ddj_index(outputs)

        if input_idx is None:
            midi_in.close_port()
            midi_out.close_port()
            self._midi_in = None
            self._midi_out = None
            self._state = MidiDeviceState(inputs, outputs, None, None)
            return

        midi_in.open_port(input_idx)
        midi_in.set_callback(self._on_midi_message)
        if output_idx is not None:
            midi_out.open_port(output_idx)
        else:
            midi_out.close_port()
            midi_out = None

        self._midi_in = midi_in
        self._midi_out = midi_out
        self._state = MidiDeviceState(
            inputs=inputs,
            outputs=outputs,
            input_name=inputs[input_idx],
            output_name=outputs[output_idx] if output_idx is not None else None,
        )

    def _ports_changed(self) -> bool:
        if not self._rtmidi:
            return False
        probe_in = self._rtmidi.MidiIn()
        probe_out = self._rtmidi.MidiOut()
        try:
            inputs = list(probe_in.get_ports())
            outputs = list(probe_out.get_ports())
        finally:
            try:
                probe_in.close_port()
            except Exception:
                pass
            try:
                probe_out.close_port()
            except Exception:
                pass
        return inputs != self._state.inputs or outputs != self._state.outputs

    def _on_midi_message(self, event, _data=None) -> None:
        message, delta_time = event
        payload = {
            "type": "midi",
            "data": [int(v) & 0xFF for v in message],
            "ts": time.time(),
            "delta": delta_time,
        }
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._broadcast(payload), self._loop)

    def send_midi(self, data: list[int]) -> None:
        with self._send_lock:
            if self._midi_out:
                self._midi_out.send_message([int(v) & 0xFF for v in data])

    def _close_midi(self) -> None:
        for port in (self._midi_in, self._midi_out):
            if not port:
                continue
            try:
                port.close_port()
            except Exception:
                pass
        self._midi_in = None
        self._midi_out = None

    # --------------------------------------------------------------- payloads
    @staticmethod
    def _first_ddj_index(names: list[str]) -> int | None:
        for idx, name in enumerate(names):
            if _is_ddj_sb3_name(name):
                return idx
        return None

    @staticmethod
    def _valid_midi_bytes(data: Any) -> bool:
        return (
            isinstance(data, list)
            and 1 <= len(data) <= 3
            and all(isinstance(v, int) and 0 <= v <= 255 for v in data)
        )

    def _device_payload(self) -> dict[str, list[str]]:
        return {"inputs": self._state.inputs, "outputs": self._state.outputs}

    def _selected_payload(self) -> dict[str, str | None] | None:
        if not self._state.input_name:
            return None
        return {"input": self._state.input_name, "output": self._state.output_name}

    def _device_event(self) -> dict[str, Any]:
        connected = bool(self._state.input_name)
        reason = None
        if not connected:
            reason = "DDJ-SB3 is not visible in CoreMIDI"
        return {
            "type": "device",
            "connected": connected,
            "input": self._state.input_name,
            "output": self._state.output_name,
            "reason": reason,
        }

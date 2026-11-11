/** The handshake of `codex app-server`, which every request on a connection follows. */
export async function initializeCodex(peer, capabilities = {}) {
    await peer.request('initialize', { clientInfo: { name: 'dsh-remote-agents', title: 'DSH Remote Agents', version: '0.1.0' }, capabilities });
    peer.send({ method: 'initialized', params: {} });
}

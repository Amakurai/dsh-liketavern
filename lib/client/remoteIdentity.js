const identities = new WeakMap();
let sequence = 0;
export function remoteIdentity(remote) {
    let id = identities.get(remote);
    if (id === undefined) {
        id = ++sequence;
        identities.set(remote, id);
    }
    return id;
}

import React, { useState } from 'react';
import { fileViewStyles } from './styles.js';

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** An image fitted to the pane; clicking toggles its actual size. `labels` name those two states for the button. */
export function ImagePreview({ src, name, bytes, labels }: { src: string; name: string; bytes?: number; labels: { fit: string; actual: string } }) {
  const [actual, setActual] = useState(false), [natural, setNatural] = useState<[number, number]>();
  return <div className="fv-image" data-actual={actual ? '' : undefined}><style>{fileViewStyles}</style>
    <button type="button" className="fv-image-stage" aria-label={actual ? labels.fit : labels.actual} title={actual ? labels.fit : labels.actual} onClick={() => setActual(!actual)}
      style={{ border: 'none', font: 'inherit', color: 'inherit', width: '100%' }}>
      <img src={src} alt={name} draggable={false} onLoad={event => setNatural([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])} />
    </button>
    <div className="fv-image-meta">{[natural && `${natural[0]} × ${natural[1]}`, bytes !== undefined && size(bytes)].filter(Boolean).join(' · ')}</div>
  </div>;
}

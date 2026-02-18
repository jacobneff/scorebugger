import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { mapCourtLabel } from '../utils/phase1.js';

const COURT_CODES = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

function DraggablePoolCard({ pool, disabled }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useDraggable({
    id: pool._id,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`court-assign-pool-card ${isDragging ? 'is-dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <p className="court-assign-pool-title">Pool {pool.name}</p>
      <p className="court-assign-pool-meta">{Array.isArray(pool.teamIds) ? pool.teamIds.length : 0}/3 teams</p>
      <p className="court-assign-pool-meta">
        {pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No court assigned'}
      </p>
    </article>
  );
}

function CourtSlot({ courtCode, assignedPool, activePoolId, disabled }) {
  const { setNodeRef, isOver } = useDroppable({
    id: courtCode,
    disabled,
  });

  return (
    <article
      ref={setNodeRef}
      className={`court-assign-slot ${isOver ? 'is-over' : ''} ${
        activePoolId && assignedPool ? 'is-occupied' : ''
      }`.trim()}
    >
      <p className="court-assign-slot-title">{mapCourtLabel(courtCode)}</p>
      {assignedPool ? (
        <p className="court-assign-slot-meta">Pool {assignedPool.name}</p>
      ) : (
        <p className="court-assign-slot-meta subtle">Drop a pool here</p>
      )}
    </article>
  );
}

function PoolCardPreview({ pool }) {
  if (!pool) {
    return null;
  }

  return (
    <article className="court-assign-pool-card court-assign-pool-card--overlay">
      <p className="court-assign-pool-title">Pool {pool.name}</p>
      <p className="court-assign-pool-meta">{Array.isArray(pool.teamIds) ? pool.teamIds.length : 0}/3 teams</p>
      <p className="court-assign-pool-meta">
        {pool.homeCourt ? mapCourtLabel(pool.homeCourt) : 'No court assigned'}
      </p>
    </article>
  );
}

function CourtAssignmentsBoard({
  pools,
  disabled = false,
  onAssignmentsChange,
}) {
  const [activePoolId, setActivePoolId] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 140, tolerance: 8 },
    })
  );

  const poolsByCourt = useMemo(() => {
    const byCourt = {};

    (Array.isArray(pools) ? pools : []).forEach((pool) => {
      if (pool?.homeCourt && COURT_CODES.includes(pool.homeCourt)) {
        byCourt[pool.homeCourt] = pool;
      }
    });

    return byCourt;
  }, [pools]);

  const activePool = useMemo(
    () => (Array.isArray(pools) ? pools.find((pool) => pool._id === activePoolId) : null),
    [activePoolId, pools]
  );

  const handleDragStart = (event) => {
    if (disabled) {
      return;
    }

    setActivePoolId(String(event.active.id));
  };

  const handleDragCancel = () => {
    setActivePoolId('');
  };

  const handleDragEnd = (event) => {
    const draggedPoolId = String(event?.active?.id || '');
    const targetCourt = String(event?.over?.id || '');
    setActivePoolId('');

    if (!draggedPoolId || !targetCourt || disabled || !COURT_CODES.includes(targetCourt)) {
      return;
    }

    const sourcePool = (Array.isArray(pools) ? pools : []).find((pool) => pool._id === draggedPoolId);

    if (!sourcePool || sourcePool.homeCourt === targetCourt) {
      return;
    }

    const sourceCourt = sourcePool.homeCourt || null;
    const occupyingPool = (Array.isArray(pools) ? pools : []).find(
      (pool) => pool._id !== sourcePool._id && pool.homeCourt === targetCourt
    );

    const nextPools = (Array.isArray(pools) ? pools : []).map((pool) => {
      if (pool._id === sourcePool._id) {
        return {
          ...pool,
          homeCourt: targetCourt,
        };
      }

      if (occupyingPool && pool._id === occupyingPool._id) {
        return {
          ...pool,
          homeCourt: sourceCourt,
        };
      }

      return pool;
    });

    onAssignmentsChange?.(nextPools);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <section className="court-assign-board">
        <div className="court-assign-column">
          <h3 className="secondary-title">Pools</h3>
          <p className="subtle">Drag a pool onto a court to assign it.</p>
          <div className="court-assign-pool-list">
            {(Array.isArray(pools) ? pools : []).map((pool) => (
              <DraggablePoolCard key={pool._id} pool={pool} disabled={disabled} />
            ))}
          </div>
        </div>
        <div className="court-assign-column">
          <h3 className="secondary-title">Courts</h3>
          <p className="subtle">Each court can host one pool in this phase.</p>
          <div className="court-assign-slot-list">
            {COURT_CODES.map((courtCode) => (
              <CourtSlot
                key={courtCode}
                courtCode={courtCode}
                assignedPool={poolsByCourt[courtCode] || null}
                activePoolId={activePoolId}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          <PoolCardPreview pool={activePool} />
        </DragOverlay>
      </section>
    </DndContext>
  );
}

export default CourtAssignmentsBoard;

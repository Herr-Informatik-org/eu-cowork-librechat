import { layoutBrain, mergeBrainPages, sourceHref } from '../layout';
import { graphFixture, memory } from './fixtures';

test('existing memories stay in place when ordering changes and knowledge grows', () => {
  const before = layoutBrain(graphFixture.nodes, graphFixture.edges);
  const after = layoutBrain(
    [memory({ id: 'node-new' }), ...graphFixture.nodes.toReversed()],
    graphFixture.edges,
  );
  for (const point of before) {
    const updated = after.find((item) => item.node.id === point.node.id)!;
    expect([updated.x, updated.y]).toEqual([point.x, point.y]);
    expect(Math.hypot(point.x - 420, point.y - 320)).toBeGreaterThan(90);
    expect(Math.hypot(point.x - 420, point.y - 320)).toBeLessThan(250);
  }
});

test('merging graph pages deduplicates edges and keeps newer node versions', () => {
  const newer = memory({ version: 2, text: 'Der Pilot startet mit vier Arbeitsplätzen.' });
  const result = mergeBrainPages([graphFixture, { nodes: [newer], edges: graphFixture.edges }]);
  expect(result.nodes).toHaveLength(2);
  expect(result.nodes[0]).toEqual(newer);
  expect(result.edges).toHaveLength(1);
});

test('source links can only navigate to an encoded internal conversation path', () => {
  expect(sourceHref('chat-one')).toBe('/c/chat-one');
  expect(sourceHref('https://elsewhere.example/path')).toBe(
    '/c/https%3A%2F%2Felsewhere.example%2Fpath',
  );
  expect(sourceHref('new')).toBeUndefined();
  expect(sourceHref()).toBeUndefined();
});

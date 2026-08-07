import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCameraDto } from '../src/cameras/dto/create-camera.dto';
import { UpdateCameraDto } from '../src/cameras/dto/update-camera.dto';

function recordingModeErrors(dto: object) {
  return validateSync(dto).filter((error) => error.property === 'recordingMode');
}

test('API recusa agenda enquanto não existe executor de janelas', () => {
  const create = plainToInstance(CreateCameraDto, {
    name: 'Câmera push',
    sourceMode: 'rtmp_push',
    recordingMode: 'schedule',
  });
  const update = plainToInstance(UpdateCameraDto, { recordingMode: 'schedule' });

  assert.equal(recordingModeErrors(create).length, 1);
  assert.equal(recordingModeErrors(update).length, 1);
});

test('API continua aceitando os três modos que possuem execução real', () => {
  for (const recordingMode of ['continuous', 'motion', 'manual']) {
    const update = plainToInstance(UpdateCameraDto, { recordingMode });
    assert.equal(recordingModeErrors(update).length, 0, recordingMode);
  }
});

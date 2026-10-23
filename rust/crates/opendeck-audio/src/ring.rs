//! Lock-free single-producer/single-consumer ring of interleaved f32 samples.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct Shared {
    data: Box<[UnsafeCell<f32>]>,
    mask: usize,
    head: AtomicUsize,
    tail: AtomicUsize,
}

unsafe impl Sync for Shared {}

pub struct Producer {
    shared: Arc<Shared>,
}

pub struct Consumer {
    shared: Arc<Shared>,
}

pub struct AudioRing {
    producer: Producer,
    consumer: Consumer,
}

impl AudioRing {
    pub fn new(sample_capacity: usize) -> Self {
        assert!(sample_capacity >= 2, "ring needs at least one stereo frame");
        assert!(sample_capacity.is_power_of_two(), "ring capacity must be a power of two");
        assert_eq!(sample_capacity % 2, 0, "ring capacity must hold whole stereo frames");
        let shared = Arc::new(Shared {
            data: (0..sample_capacity).map(|_| UnsafeCell::new(0.0)).collect(),
            mask: sample_capacity - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        });
        Self {
            producer: Producer { shared: shared.clone() },
            consumer: Consumer { shared },
        }
    }

    pub fn split(self) -> (Producer, Consumer) {
        (self.producer, self.consumer)
    }
}

impl Producer {
    pub fn free(&self) -> usize {
        let head = self.shared.head.load(Ordering::Relaxed);
        let tail = self.shared.tail.load(Ordering::Acquire);
        self.shared.data.len() - (head.wrapping_sub(tail))
    }

    pub fn push(&mut self, samples: &[f32]) -> usize {
        let capacity = self.shared.data.len();
        let head = self.shared.head.load(Ordering::Relaxed);
        let tail = self.shared.tail.load(Ordering::Acquire);
        let free = capacity - head.wrapping_sub(tail);
        let count = free.min(samples.len());
        let mask = self.shared.mask;
        for (offset, sample) in samples[..count].iter().enumerate() {
            let index = (head + offset) & mask;
            unsafe {
                *self.shared.data[index].get() = *sample;
            }
        }
        self.shared.head.store(head + count, Ordering::Release);
        count
    }
}

impl Consumer {
    pub fn available(&self) -> usize {
        let tail = self.shared.tail.load(Ordering::Relaxed);
        let head = self.shared.head.load(Ordering::Acquire);
        head.wrapping_sub(tail)
    }

    pub fn pop(&mut self, samples: &mut [f32]) -> usize {
        let head = self.shared.head.load(Ordering::Acquire);
        let tail = self.shared.tail.load(Ordering::Relaxed);
        let available = head.wrapping_sub(tail);
        let count = available.min(samples.len());
        let mask = self.shared.mask;
        for (offset, sample) in samples[..count].iter_mut().enumerate() {
            let index = (tail + offset) & mask;
            unsafe {
                *sample = *self.shared.data[index].get();
            }
        }
        self.shared.tail.store(tail + count, Ordering::Release);
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_preserves_order_and_wraps() {
        let (mut producer, mut consumer) = AudioRing::new(8).split();
        let input = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        assert_eq!(producer.push(&input), 8);
        let mut output = [0.0; 6];
        assert_eq!(consumer.pop(&mut output), 6);
        assert_eq!(output, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(producer.push(&[9.0, 10.0, 11.0, 12.0]), 4);
        assert_eq!(consumer.pop(&mut output), 6);
        assert_eq!(output, [7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
    }

    #[test]
    fn ring_reports_free_space_and_drops_overflow() {
        let (mut producer, mut consumer) = AudioRing::new(4).split();
        assert_eq!(producer.free(), 4);
        assert_eq!(producer.push(&[1.0, 2.0, 3.0, 4.0, 5.0]), 4);
        assert_eq!(producer.free(), 0);
        assert_eq!(consumer.available(), 4);
        let mut output = [0.0; 4];
        assert_eq!(consumer.pop(&mut output), 4);
        assert_eq!(output, [1.0, 2.0, 3.0, 4.0]);
    }
}

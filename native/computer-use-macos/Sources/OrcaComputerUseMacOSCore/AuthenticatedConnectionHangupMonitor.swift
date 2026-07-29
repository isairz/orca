import Darwin
import Dispatch
import Foundation

public final class AuthenticatedConnectionHangupMonitor: @unchecked Sendable {
    private static let cancelEventIdentifier: UInt = 1

    private let eventQueue: DispatchQueue
    private let eventQueueDescriptor: Int32
    private let stateLock = NSLock()
    private let onHangup: @Sendable () -> Void
    private var isCancelled = false
    private var didReportHangup = false
    private var isFinished = false

    public init?(
        fileDescriptor: Int32,
        queue: DispatchQueue = DispatchQueue(
            label: "com.stablyai.orca.computer-use-owner-hangup"
        ),
        onHangup: @escaping @Sendable () -> Void
    ) {
        eventQueue = queue
        self.onHangup = onHangup
        eventQueueDescriptor = kqueue()
        guard eventQueueDescriptor >= 0 else {
            return nil
        }
        var registrations = [
            kevent(
                ident: UInt(fileDescriptor),
                filter: Int16(EVFILT_READ),
                flags: UInt16(EV_ADD | EV_CLEAR),
                fflags: 0,
                data: 0,
                udata: nil
            ),
            kevent(
                ident: Self.cancelEventIdentifier,
                filter: Int16(EVFILT_USER),
                flags: UInt16(EV_ADD | EV_CLEAR),
                fflags: 0,
                data: 0,
                udata: nil
            )
        ]
        let registrationResult = registrations.withUnsafeMutableBufferPointer { buffer in
            kevent(eventQueueDescriptor, buffer.baseAddress, Int32(buffer.count), nil, 0, nil)
        }
        guard registrationResult == 0 else {
            close(eventQueueDescriptor)
            return nil
        }
        eventQueue.async { [self] in
            waitForHangup()
        }
    }

    public func cancel() {
        stateLock.lock()
        guard !isFinished else {
            stateLock.unlock()
            return
        }
        isCancelled = true
        var event = kevent(
            ident: Self.cancelEventIdentifier,
            filter: Int16(EVFILT_USER),
            flags: 0,
            fflags: UInt32(NOTE_TRIGGER),
            data: 0,
            udata: nil
        )
        _ = kevent(eventQueueDescriptor, &event, 1, nil, 0, nil)
        stateLock.unlock()
    }

    private func waitForHangup() {
        defer { finish() }
        while true {
            var event = kevent()
            let result = kevent(eventQueueDescriptor, nil, 0, &event, 1, nil)
            if result < 0 && errno == EINTR {
                continue
            }
            guard result > 0 else { return }
            if event.filter == Int16(EVFILT_USER) {
                return
            }
            if event.flags & UInt16(EV_EOF | EV_ERROR) != 0 {
                reportHangup()
                return
            }
        }
    }

    private func finish() {
        stateLock.lock()
        isFinished = true
        close(eventQueueDescriptor)
        stateLock.unlock()
    }

    private func reportHangup() {
        stateLock.lock()
        guard !isCancelled, !didReportHangup else {
            stateLock.unlock()
            return
        }
        didReportHangup = true
        stateLock.unlock()

        onHangup()
    }
}

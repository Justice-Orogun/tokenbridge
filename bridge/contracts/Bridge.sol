pragma solidity >=0.4.21 <0.6.0;

import "./zeppelin/token/ERC20/ERC20Detailed.sol";
import "./zeppelin/token/ERC20/SafeERC20.sol";
import "./zeppelin/lifecycle/Pausable.sol";
import "./zeppelin/math/SafeMath.sol";
import "./ERC677TransferReceiver.sol";
import "./Transferable.sol";
import "./SideToken.sol";

contract Bridge is Transferable, ERC677TransferReceiver, Pausable {
    using SafeMath for uint256;
    using SafeERC20 for ERC20Detailed;

    address public manager;
    uint8 symbolPrefix;
    uint256 public lastCrossEventBlock;
    uint256 public blocksBetweenCrossEvents;
    uint256 public minimumPedingTransfersCount;

    mapping (address => SideToken) public mappedTokens;
    mapping (address => address) public sideTokens;
    mapping (address => address) public mappedAddresses;
    mapping (address => uint256) public lockedTokens;

    struct TransferStruct {
        ERC20Detailed from;
        address to;
        uint256 amount;
        string symbol;
    }
    uint256 public pendingTransfersCount;
    TransferStruct[] public pendingTransferStruct;
    event Cross(address indexed _tokenAddress, address indexed _to, uint256 _amount, string _symbol);

    modifier onlyManager() {
        require(msg.sender == manager, "Sender is not the manager");
        _;
    }

    constructor(address _manager, uint8 _symbolPrefix, uint256 _blocksBetweenCrossEvents, uint256 _minimumPedingTransfersCount) public {
        require(_manager != address(0), "Empty manager");
        require(_symbolPrefix != 0, "Empty symbol prefix");
        manager = _manager;
        symbolPrefix = _symbolPrefix;
        pendingTransfersCount = 0;
        blocksBetweenCrossEvents = _blocksBetweenCrossEvents;
        minimumPedingTransfersCount = _minimumPedingTransfersCount;
    }

    function onTokenTransfer(address to, uint256 amount, bytes memory data) public whenNotPaused returns (bool success) {
        return tokenFallback(to, amount, data);
    }

    function addPendingTransfer(ERC20Detailed fromToken, address to, uint256 amount) private whenNotPaused returns (bool success) {
        validateToken(fromToken);
        //TODO should group by address and sender
        pendingTransferStruct.push(TransferStruct(fromToken, to, amount, fromToken.symbol()));
        pendingTransfersCount++;
        return true;
    }

    function emmitEvent() public whenNotPaused returns (bool success) {
        //TODO add validations
        if(block.number > lastCrossEventBlock + blocksBetweenCrossEvents || pendingTransfersCount > minimumPedingTransfersCount ) {
            for(uint256 i = 0; i < pendingTransfersCount; i++) {
                TransferStruct memory transfer = pendingTransferStruct[i];
                address tokenFromAddress = address(transfer.from);
                emit Cross(tokenFromAddress, transfer.to, transfer.amount, transfer.symbol);
                delete pendingTransferStruct[i];
                lockedTokens[tokenFromAddress] = lockedTokens[tokenFromAddress].add(transfer.amount);
            }
            pendingTransfersCount = 0;
            lastCrossEventBlock = block.number;
            return true;
        }
        return false;
    }
    
    function processToken(address token, string memory symbol) public returns (bool) {
        return true;
    }

    function acceptTransfer(address tokenAddress, address receiver, uint256 amount, string memory symbol)
    public onlyManager whenNotPaused returns(bool) {
        address to = getMappedAddress(receiver);
        uint256 totalAmount = lockedTokens[tokenAddress];
        //TODO find a bettr way to check if they are comming from main or side chain
        //perhaps set it as 2 diferent methods
        if(totalAmount == 0) {
            //Crossing
            SideToken sideTokenContract = mappedTokens[tokenAddress];
            if(address(sideTokenContract) == address(0)) {
                string memory newSymbol = string(abi.encodePacked(symbolPrefix, symbol));
                sideTokenContract = new SideToken(newSymbol,newSymbol);
                mappedTokens[tokenAddress] = sideTokenContract;
                sideTokens[address(sideTokenContract)] = tokenAddress;
            }
            return sideTokenContract.mint(to, amount);
        } else {
            //Crossing Back
            require(amount <= totalAmount, "Amount bigger than actual tokens in the bridge");
            ERC20Detailed tokenContract = ERC20Detailed(tokenAddress);
            tokenContract.safeTransfer(to, amount);
            lockedTokens[tokenAddress] = totalAmount.sub(amount);
        }
    }

    function changeManager(address newmanager) public onlyManager whenNotPaused {
        require(newmanager != address(0), "New manager address is empty");
        manager = newmanager;
    }

    function tokenFallback(address from, uint256 amount, bytes memory) public whenNotPaused returns (bool) {
        //TODO add validations and manage callback from contracts correctly
        //TODO If its a mirror contract created by us we should brun the tokens and sent then back. If not we shoulld add it to the pending trasnfer
        address originalTokenAddress = sideTokens[msg.sender];
        require(originalTokenAddress != address(0), "Sender is not one of the crossed token contracts");
        SideToken sideToken = SideToken(msg.sender);
        addPendingTransfer(ERC20Detailed(originalTokenAddress), from, amount);
        sideToken.burn(amount);
        return true;
    }

    function mapAddress(address to) public whenNotPaused {
        mappedAddresses[msg.sender] = to;
    }

    function getMappedAddress(address account) public view returns (address) {
        address mapped = mappedAddresses[account];

        if (mapped == address(0))
            return account;

        return mapped;
    }

    function validateToken(ERC20Detailed tokenToUse) private view {
        require(tokenToUse.decimals() == 18, "Token has decimals other than 18");
        require(bytes(tokenToUse.symbol()).length != 0, "Token doesn't have symbol");
    }

    function receiveTokens(ERC20Detailed tokenToUse, uint256 amount) public whenNotPaused returns (bool) {
        //TODO should we accept  that people call receiveTokens with the SideToken???
        validateToken(tokenToUse);
        tokenToUse.safeTransferFrom(msg.sender, address(this), amount);
        return addPendingTransfer(tokenToUse, msg.sender, amount);
    }

}

